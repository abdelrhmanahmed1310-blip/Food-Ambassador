import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sign } from "@/modules/integrations/crypto";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addManualPunch,
  attendanceBoard,
  clockAtTerminal,
  clockFromPhone,
  createAttendanceDevice,
  createTerminal,
  employeePunches,
  handleAttendanceInbound,
  myAttendance,
  setEmployeePin,
  setGeofence,
  setTerminalActive,
  voidPunch,
} from "./attendance";
import { changeEmployeeStatus, createEmployee } from "./service";

/** Time and attendance (ADR-080). */

let ctx: TenantContext;
let other: TenantContext;
let staff: TenantContext;
let branchId: string;
let cook: { id: string; number: string };
let token: string;
const OLAYA = { latitude: 24.6905, longitude: 46.6855 };

beforeAll(async () => {
  ({ ctx } = await createTenant("att", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  ({ ctx: other } = await createTenant("att-other", {
    baseCurrency: "SAR",
    timeZone: "Asia/Riyadh",
  }));
  branchId = (await createBranch(ctx, { code: "RUH", name: "Olaya", type: "RESTAURANT" })).id;
  const c = await createEmployee(ctx, {
    firstName: "Omar",
    lastName: "Nasser",
    jobTitle: "Cook",
    branchId,
    employmentType: "FULL_TIME",
    hireDate: "2026-01-01",
  });
  cook = { id: c.id, number: c.number };
  token = (await createTerminal(ctx, { branchId, name: "Kitchen door" })).publicToken;
  // A staff member who signs in and is linked to an employee record.
  const { ctx: s, user } = await addMember(ctx, "cashier");
  staff = s;
  await createEmployee(ctx, {
    firstName: "Majed",
    lastName: "Dosari",
    jobTitle: "Cashier",
    branchId,
    employmentType: "FULL_TIME",
    hireDate: "2026-01-01",
    userId: user.id,
  });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("time and attendance (ADR-080)", () => {
  it("branch tablet: number and PIN clock in, then out; wrong PINs lock the PIN", async () => {
    expect(
      await clockAtTerminal(token, { employeeNumber: cook.number, pin: "1234" }, "1.1.1.1"),
    ).toEqual({
      ok: false,
      error: "INVALID",
    }); // no PIN set yet
    await expectAppError(setEmployeePin(ctx, cook.id, { pin: "12" }), "VALIDATION_FAILED");
    await setEmployeePin(ctx, cook.id, { pin: "4821" });
    const first = await clockAtTerminal(
      token,
      { employeeNumber: cook.number.toLowerCase(), pin: "4821" },
      "1.1.1.1",
    );
    expect(first).toMatchObject({ ok: true, firstName: "Omar", kind: "IN" });
    const second = await clockAtTerminal(
      token,
      { employeeNumber: cook.number, pin: "4821" },
      "1.1.1.1",
    );
    expect(second).toMatchObject({ ok: true, kind: "OUT" });
    for (let i = 0; i < 4; i++)
      expect(
        (await clockAtTerminal(token, { employeeNumber: cook.number, pin: "0000" }, "1.1.1.1")).ok,
      ).toBe(false);
    expect(
      await clockAtTerminal(token, { employeeNumber: cook.number, pin: "0000" }, "1.1.1.1"),
    ).toEqual({
      ok: false,
      error: "LOCKED",
    });
    expect(
      await clockAtTerminal(token, { employeeNumber: cook.number, pin: "4821" }, "1.1.1.1"),
    ).toEqual({
      ok: false,
      error: "LOCKED",
    });
    // HR resetting the PIN unlocks it.
    await setEmployeePin(ctx, cook.id, { pin: "4821" });
    expect(
      (await clockAtTerminal(token, { employeeNumber: cook.number, pin: "4821" }, "1.1.1.1")).ok,
    ).toBe(true);
    expect(await getDb().attendancePunch.count({ where: { employeeId: cook.id } })).toBe(3);
  });

  it("a switched-off tablet and an employee on leave cannot clock in", async () => {
    const t = await getDb().attendanceTerminal.findFirstOrThrow({ where: { publicToken: token } });
    await setTerminalActive(ctx, t.id, false);
    expect(
      (await clockAtTerminal(token, { employeeNumber: cook.number, pin: "4821" }, "1.1.1.1")).ok,
    ).toBe(false);
    await setTerminalActive(ctx, t.id, true);
    await changeEmployeeStatus(ctx, cook.id, { status: "ON_LEAVE" });
    expect(
      await clockAtTerminal(token, { employeeNumber: cook.number, pin: "4821" }, "1.1.1.1"),
    ).toEqual({
      ok: false,
      error: "NOT_ACTIVE",
    });
    await changeEmployeeStatus(ctx, cook.id, { status: "ACTIVE" });
  });

  it("phone: the linked employee clocks in; within the branch radius when one is set", async () => {
    expect((await clockFromPhone(staff, {})).kind).toBe("IN");
    await setGeofence(ctx, branchId, { ...OLAYA, radiusMeters: "150" });
    await expectAppError(clockFromPhone(staff, {}), "BUSINESS_RULE_VIOLATION"); // location needed
    await expectAppError(
      clockFromPhone(staff, { latitude: 24.7, longitude: 46.6855 }), // about 1 km away
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await clockFromPhone(staff, { latitude: 24.6914, longitude: 46.6855 })).kind).toBe(
      "OUT",
    );
    const last = await getDb().attendancePunch.findFirstOrThrow({
      where: { source: "PHONE" },
      orderBy: { at: "desc" },
    });
    expect(last.distanceMeters).toBe(100); // the distance is kept, not the location
    const mine = (await myAttendance(staff))!;
    expect(mine.needsLocation).toBe(true);
    expect(mine.clockedIn).toBe(false);
    expect(await myAttendance(other)).toBeNull();
    await expectAppError(clockFromPhone(ctx, {}), "BUSINESS_RULE_VIOLATION"); // owner is not an employee
  });

  it("device: signed batches; repeats ignored, unknown numbers reported", async () => {
    const device = await createAttendanceDevice(ctx, { name: "Face reader", branchId });
    const send = async (payload: unknown) => {
      const body = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      return handleAttendanceInbound({
        publicId: device.publicId,
        body,
        headers: {
          timestamp,
          signature: sign(device.secret, timestamp, body),
          idempotencyKey: randomUUID(),
        },
      });
    };
    const at = new Date(Date.now() - 60_000).toISOString();
    const batch = {
      punches: [
        { id: "dev-1", employeeNumber: cook.number, at },
        { id: "dev-2", employeeNumber: "NOBODY", at },
      ],
    };
    expect((await send(batch)).body).toMatchObject({
      accepted: 1,
      duplicates: 0,
      unknown: ["NOBODY"],
    });
    expect((await send(batch)).body).toMatchObject({ accepted: 0, duplicates: 1 });
    expect((await send({ punches: [] })).status).toBe(400);
    const unsigned = await handleAttendanceInbound({
      publicId: device.publicId,
      body: JSON.stringify(batch),
      headers: {
        timestamp: String(Math.floor(Date.now() / 1000)),
        signature: null,
        idempotencyKey: randomUUID(),
      },
    });
    expect(unsigned.status).toBe(401);
  });

  it("HR adds a missed punch with a reason and voids a wrong one; the board shows the day", async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" });
    await expectAppError(
      addManualPunch(ctx, cook.id, { kind: "IN", date: "2099-01-01", time: "09:00", reason: "x" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      addManualPunch(ctx, cook.id, { kind: "IN", date: today, time: "00:01" }),
      "VALIDATION_FAILED",
    );
    const p = await addManualPunch(ctx, cook.id, {
      kind: "OUT",
      date: today,
      time: "00:02",
      reason: "Forgot to clock out",
    });
    await voidPunch(ctx, p.id, { reason: "Entered twice" });
    await expectAppError(voidPunch(ctx, p.id, { reason: "again" }), "NOT_FOUND");
    await expect(
      getDb().attendancePunch.update({ where: { id: p.id }, data: { at: new Date() } }),
    ).rejects.toThrow(); // punches are never edited
    const history = await employeePunches(ctx, cook.id);
    expect(history.punches.find((x) => x.id === p.id)?.voidReason).toBe("Entered twice");
    expect(history.hasPin).toBe(true);
    const board = await attendanceBoard(ctx);
    const row = board.rows.find((r) => r.employee.id === cook.id)!;
    expect(row.sheet).not.toBeNull();
    expect(row.sources).toEqual(expect.arrayContaining(["TERMINAL", "DEVICE"]));
  });

  it("never mixes organizations", async () => {
    const p = await getDb().attendancePunch.findFirstOrThrow({
      where: { employeeId: cook.id, voidedAt: null },
    });
    await expectAppError(voidPunch(other, p.id, { reason: "x" }), "NOT_FOUND");
    await expectAppError(setEmployeePin(other, cook.id, { pin: "1111" }), "NOT_FOUND");
    expect((await attendanceBoard(other)).rows).toEqual([]);
    await expectAppError(
      setGeofence(other, branchId, { ...OLAYA, radiusMeters: "100" }),
      "NOT_FOUND",
    );
  });
});
