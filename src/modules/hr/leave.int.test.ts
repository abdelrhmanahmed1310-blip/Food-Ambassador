import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addCommonLeaveTypes,
  cancelLeave,
  decideLeave,
  employeeLeave,
  listLeaveRequests,
  listLeaveTypes,
  myLeave,
  requestLeave,
  setLeaveAllocation,
} from "./leave";
import { createEmployee } from "./service";

/** Leave (ADR-081). */

let ctx: TenantContext;
let other: TenantContext;
let chefCtx: TenantContext;
let cookCtx: TenantContext;
let peerCtx: TenantContext;
let chef: string;
let cook: string;
let annual: string;
let unpaid: string;
const Y = new Date().getUTCFullYear() + 1; // next year: every date is in the future

beforeAll(async () => {
  ({ ctx } = await createTenant("leave", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  ({ ctx: other } = await createTenant("leave-other", {
    baseCurrency: "SAR",
    timeZone: "Asia/Riyadh",
  }));
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Olaya", type: "RESTAURANT" })).id;
  const person = async (first: string, managerId: string | null, role: string) => {
    const m = await addMember(ctx, role, {}, `leave-${first.toLowerCase()}`);
    const e = await createEmployee(ctx, {
      firstName: first,
      lastName: "Test",
      jobTitle: "Staff",
      branchId,
      employmentType: "FULL_TIME",
      hireDate: "2026-01-01",
      managerId: managerId ?? "",
      userId: m.user.id,
    });
    return { id: e.id, ctx: m.ctx };
  };
  const c = await person("Huda", null, "cashier");
  chef = c.id;
  chefCtx = c.ctx;
  const k = await person("Omar", chef, "cashier");
  cook = k.id;
  cookCtx = k.ctx;
  peerCtx = (await person("Reem", chef, "cashier")).ctx;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("leave (ADR-081)", () => {
  it("adds the common leave types once, without entitlements", async () => {
    expect(await addCommonLeaveTypes(ctx)).toBe(10);
    expect(await addCommonLeaveTypes(ctx)).toBe(0);
    const types = await listLeaveTypes(ctx);
    annual = types.find((t) => t.code === "ANNUAL")!.id;
    unpaid = types.find((t) => t.code === "UNPAID")!.id;
    expect(
      await getDb().leaveAllocation.count({ where: { organizationId: ctx.organizationId } }),
    ).toBe(0);
    await expectAppError(addCommonLeaveTypes(cookCtx), "FORBIDDEN");
  });

  it("HR sets entitlements; types without a balance cannot have one", async () => {
    await setLeaveAllocation(ctx, cook, { leaveTypeId: annual, year: String(Y), days: "21" });
    await expectAppError(
      setLeaveAllocation(ctx, cook, { leaveTypeId: unpaid, year: String(Y), days: "5" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      setLeaveAllocation(cookCtx, cook, { leaveTypeId: annual, year: String(Y), days: "99" }),
      "FORBIDDEN",
    );
  });

  it("the employee requests leave within balance; overlaps and cross-year ranges are refused", async () => {
    await expectAppError(
      requestLeave(cookCtx, null, {
        leaveTypeId: annual,
        startDate: `${Y}-03-01`,
        endDate: `${Y}-03-25`,
      }),
      "BUSINESS_RULE_VIOLATION",
    ); // 25 days > 21
    const r = await requestLeave(cookCtx, null, {
      leaveTypeId: annual,
      startDate: `${Y}-03-01`,
      endDate: `${Y}-03-10`,
      reason: "Family",
    });
    expect(Number(r.days)).toBe(10);
    await expectAppError(
      requestLeave(cookCtx, null, {
        leaveTypeId: unpaid,
        startDate: `${Y}-03-10`,
        endDate: `${Y}-03-12`,
      }),
      "BUSINESS_RULE_VIOLATION",
    ); // overlap
    await expectAppError(
      requestLeave(cookCtx, null, {
        leaveTypeId: unpaid,
        startDate: `${Y}-12-30`,
        endDate: `${Y + 1}-01-02`,
      }),
      "VALIDATION_FAILED",
    );
    // Unpaid leave needs no balance.
    await requestLeave(cookCtx, null, {
      leaveTypeId: unpaid,
      startDate: `${Y}-05-01`,
      endDate: `${Y}-05-03`,
    });
    const mine = (await myLeave(cookCtx))!;
    expect(mine.mine).toHaveLength(2);
  });

  it("the direct manager approves; a colleague cannot; balances follow", async () => {
    const team = (await myLeave(chefCtx))!.team;
    expect(team.map((r) => Number(r.days))).toEqual([10, 3]);
    await expectAppError(decideLeave(peerCtx, team[0].id, { decision: "APPROVED" }), "NOT_FOUND");
    await expectAppError(decideLeave(cookCtx, team[0].id, { decision: "APPROVED" }), "NOT_FOUND"); // not one's own
    await decideLeave(chefCtx, team[0].id, { decision: "APPROVED", note: "Enjoy" });
    await expectAppError(
      decideLeave(chefCtx, team[0].id, { decision: "REJECTED" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await decideLeave(ctx, team[1].id, { decision: "REJECTED", note: "Busy week" }); // HR may decide too
    const leave = await employeeLeave(ctx, cook, Y);
    const a = leave.balances.find((b) => b.type.code === "ANNUAL")!;
    expect([
      a.allocated?.toFixed(0),
      a.approved.toFixed(0),
      a.pending.toFixed(0),
      a.remaining?.toFixed(0),
    ]).toEqual(["21", "10", "0", "11"]);
    await expect(
      getDb().leaveRequest.update({ where: { id: team[0].id }, data: { days: "1" } }),
    ).rejects.toThrow(); // dates and days never change
  });

  it("cancellation: the employee while pending; HR after approval before it starts", async () => {
    const r = await requestLeave(cookCtx, null, {
      leaveTypeId: annual,
      startDate: `${Y}-07-01`,
      endDate: `${Y}-07-02`,
    });
    await cancelLeave(cookCtx, r.id);
    const approved = (await listLeaveRequests(ctx, "APPROVED"))[0];
    await expectAppError(cancelLeave(cookCtx, approved.id), "BUSINESS_RULE_VIOLATION");
    await cancelLeave(ctx, approved.id);
    const a = (await employeeLeave(ctx, cook, Y)).balances.find((b) => b.type.code === "ANNUAL")!;
    expect(a.remaining?.toFixed(0)).toBe("21");
  });

  it("nobody approves their own leave, not even with HR rights", async () => {
    const { ctx: hrCtx, user } = await addMember(ctx, "admin", {}, "leave-hr");
    const own = await createEmployee(ctx, {
      firstName: "Hana",
      lastName: "Test",
      jobTitle: "HR",
      branchId: (
        await getDb().branch.findFirstOrThrow({ where: { organizationId: ctx.organizationId } })
      ).id,
      employmentType: "FULL_TIME",
      hireDate: "2026-01-01",
      userId: user.id,
    });
    const r = await requestLeave(hrCtx, null, {
      leaveTypeId: unpaid,
      startDate: `${Y}-10-01`,
      endDate: `${Y}-10-01`,
    });
    await expectAppError(decideLeave(hrCtx, r.id, { decision: "APPROVED" }), "NOT_FOUND");
    await decideLeave(ctx, r.id, { decision: "APPROVED" });
    expect((await employeeLeave(ctx, own.id, Y)).requests[0].status).toBe("APPROVED");
  });

  it("never mixes organizations", async () => {
    const r = await requestLeave(ctx, cook, {
      leaveTypeId: annual,
      startDate: `${Y}-09-01`,
      endDate: `${Y}-09-01`,
    });
    await expectAppError(decideLeave(other, r.id, { decision: "APPROVED" }), "NOT_FOUND");
    await expectAppError(cancelLeave(other, r.id), "NOT_FOUND");
    await expectAppError(employeeLeave(other, cook), "NOT_FOUND");
    expect(await myLeave(other)).toBeNull();
    expect(await listLeaveTypes(other)).toEqual([]);
  });
});
