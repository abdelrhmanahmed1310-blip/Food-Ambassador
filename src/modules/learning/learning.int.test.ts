import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { createEmployee } from "@/modules/hr/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { expiryFor } from "./rules";
import {
  addExternalRecord,
  addParticipants,
  addRequirement,
  cancelSession,
  completeSession,
  complianceMatrix,
  createCourse,
  employeeTraining,
  exportComplianceCsv,
  getSession,
  listSessions,
  myTraining,
  recordAttendance,
  scheduleSession,
  voidRecord,
} from "./service";

/** Training, certificates and compliance (ADR-125). */

let ctx: TenantContext;
let today: string;
let olaya: string;
let malqa: string;
let cookA: { id: string; ctx: TenantContext };
let cookB: string;
let cashier: string;
let fh: string; // food hygiene, valid 12 months
let fire: string; // no expiry

async function expectRule(promise: Promise<unknown>, rule: string) {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; details?: { rule?: string } };
    expect(`${e.code}:${e.details?.rule}`).toBe(`BUSINESS_RULE_VIOLATION:${rule}`);
    return;
  }
  throw new Error(`Expected ${rule} but the call succeeded`);
}
const cell = async (employeeId: string, courseId: string, c: TenantContext = ctx) =>
  (await complianceMatrix(c)).rows
    .find((r) => r.employee.id === employeeId)
    ?.cells.find((x) => x.courseId === courseId);

beforeAll(async () => {
  ({ ctx } = await createTenant("learning", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  today = businessDate(ctx.timeZone);
  olaya = (await createBranch(ctx, { code: "OLY", name: "Olaya", type: "RESTAURANT" })).id;
  malqa = (await createBranch(ctx, { code: "MLQ", name: "Malqa", type: "RESTAURANT" })).id;
  const hire = async (
    first: string,
    jobTitle: string,
    branchId: string,
    daysAgo: number,
    userId?: string,
  ) =>
    (
      await createEmployee(ctx, {
        firstName: first,
        lastName: "Test",
        jobTitle,
        branchId,
        employmentType: "FULL_TIME",
        hireDate: addDays(today, -daysAgo),
        ...(userId ? { userId } : {}),
      })
    ).id;
  const member = await addMember(ctx, "cashier", {}, "learning-cook");
  cookA = { id: await hire("Amal", "Line cook", olaya, 60, member.user.id), ctx: member.ctx };
  cookB = await hire("Badr", "Line Cook", malqa, 10);
  cashier = await hire("Carla", "Cashier", olaya, 60);
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("courses and requirements (ADR-125)", () => {
  it("keeps a catalogue and who must hold what", async () => {
    fh = (
      await createCourse(ctx, {
        code: "fh-1",
        name: "Food hygiene",
        category: "FOOD_SAFETY",
        delivery: "IN_PERSON",
        validityMonths: "12",
      })
    ).id;
    fire = (
      await createCourse(ctx, {
        code: "FIRE",
        name: "Fire safety",
        category: "FIRE_SAFETY",
        delivery: "ON_THE_JOB",
      })
    ).id;
    await expectAppError(
      createCourse(ctx, {
        code: "FH-1",
        name: "Again",
        category: "FOOD_SAFETY",
        delivery: "ONLINE",
      }),
      "CONFLICT",
    );
    await expectAppError(
      addRequirement(ctx, { courseId: fh, scope: "JOB_TITLE" }),
      "VALIDATION_FAILED",
    );
    await addRequirement(ctx, {
      courseId: fh,
      scope: "JOB_TITLE",
      jobTitle: "line cook",
      dueWithinDays: "30",
    });
    await addRequirement(ctx, { courseId: fire, scope: "ALL", dueWithinDays: "90" });

    // Job titles match regardless of case; deadlines run from hire.
    expect((await cell(cookA.id, fh))?.status).toBe("OVERDUE");
    expect((await cell(cookB, fh))?.status).toBe("DUE");
    expect(await cell(cashier, fh)).toBeUndefined();
    expect((await cell(cashier, fire))?.status).toBe("DUE");
    expect((await attentionItems(ctx)).find((i) => i.key === "TRAINING_LAPSED")?.count).toBe(1);
  });
});

describe("sessions (ADR-125)", () => {
  it("takes attendance and results, and records passes with their expiry", async () => {
    await expectAppError(
      scheduleSession(ctx, {
        courseId: fh,
        branchId: olaya,
        date: today,
        time: "25:00",
        trainer: "Nour",
      }),
      "VALIDATION_FAILED",
    );
    const s = await scheduleSession(ctx, {
      courseId: fh,
      branchId: olaya,
      date: today,
      time: "09:00",
      trainer: "Nour (municipality trainer)",
      capacity: "1",
    });
    expect(s.number).toMatch(/^TRN-/);
    await addParticipants(ctx, s.id, [cookA.id]);
    await expectRule(addParticipants(ctx, s.id, [cashier]), "TRAINING_SESSION_FULL");
    await expectRule(completeSession(ctx, s.id), "TRAINING_ATTENDANCE_MISSING");
    await expectAppError(
      recordAttendance(ctx, s.id, cookA.id, { attendance: "ABSENT", result: "PASSED" }),
      "VALIDATION_FAILED",
    );
    await recordAttendance(ctx, s.id, cookA.id, { attendance: "ATTENDED", result: "PASSED" });
    expect((await completeSession(ctx, s.id)).passed).toBe(1);
    const c = await cell(cookA.id, fh);
    expect([c?.status, c?.expiresOn]).toEqual(["COMPLIANT", expiryFor(today, 12)]);
    // A completed session is closed, in the service and in the database.
    await expectRule(
      recordAttendance(ctx, s.id, cookA.id, { attendance: "ABSENT" }),
      "TRAINING_SESSION_CLOSED",
    );
    await expect(
      getDb().trainingParticipant.updateMany({
        where: { sessionId: s.id },
        data: { attendance: "ABSENT" },
      }),
    ).rejects.toThrow();
    expect((await getSession(ctx, s.id)).canManage).toBe(false);

    const empty = await scheduleSession(ctx, {
      courseId: fire,
      branchId: olaya,
      date: today,
      time: "14:00",
      trainer: "Nour",
    });
    await expectRule(completeSession(ctx, empty.id), "TRAINING_SESSION_EMPTY");
    await cancelSession(ctx, empty.id, { reason: "Trainer ill" });
    expect((await listSessions(ctx)).sessions.map((x) => x.status).sort()).toEqual([
      "CANCELLED",
      "COMPLETED",
    ]);
  });
});

describe("records from elsewhere (ADR-125)", () => {
  it("adds outside certificates, shows them expiring, and voids mistakes", async () => {
    await expectRule(
      addExternalRecord(ctx, cookB, {
        courseId: fh,
        completedOn: addDays(today, 1),
        provider: "Academy",
      }),
      "TRAINING_IN_FUTURE",
    );
    // Passed 360 days ago, valid 12 months: expires within the month.
    const r = await addExternalRecord(ctx, cookB, {
      courseId: fh,
      completedOn: addDays(today, -360),
      provider: "Riyadh Food Academy",
      certificateNumber: "RFA-1234",
    });
    expect((await cell(cookB, fh))?.status).toBe("EXPIRING");
    expect((await attentionItems(ctx)).find((i) => i.key === "TRAINING_EXPIRING")?.count).toBe(1);
    await expect(
      getDb().trainingRecord.update({ where: { id: r.id }, data: { completedOn: new Date() } }),
    ).rejects.toThrow();
    await voidRecord(ctx, r.id, { reason: "Wrong employee" });
    expect((await cell(cookB, fh))?.status).toBe("DUE");
    await expectRule(voidRecord(ctx, r.id, { reason: "Again" }), "TRAINING_RECORD_VOIDED");

    const csv = await exportComplianceCsv(ctx);
    expect(csv).toContain("FH-1,COMPLIANT");
    expect(
      csv
        .split("\n")[0]
        .replace(/^\uFEFF/, "")
        .trim(),
    ).toBe("employee_number,name,branch,job_title,course,status,due_on,expires_on");
  });

  it("shows each employee their own training", async () => {
    const mine = await myTraining(cookA.ctx);
    expect(mine.records.map((r) => r.course.code)).toEqual(["FH-1"]);
    expect(mine.required.map((c) => c.status).sort()).toEqual(["COMPLIANT", "DUE"]);
    await expectAppError(employeeTraining(cookA.ctx, cookB), "NOT_FOUND");
  });
});

describe("access (ADR-125)", () => {
  it("is per branch for sessions and records; the catalogue is organization-wide", async () => {
    const manager = await addMember(ctx, "branch_manager", {
      scopeType: "BRANCH",
      branchId: olaya,
    });
    const m = await complianceMatrix(manager.ctx);
    expect(m.rows.map((r) => r.employee.id).sort()).toEqual([cookA.id, cashier].sort());
    await expectAppError(
      scheduleSession(manager.ctx, {
        courseId: fh,
        branchId: malqa,
        date: today,
        time: "09:00",
        trainer: "X",
      }),
      "FORBIDDEN",
    );
    await expectAppError(
      addExternalRecord(manager.ctx, cookB, { courseId: fh, completedOn: today, provider: "X" }),
      "NOT_FOUND",
    );
    await expectAppError(
      createCourse(manager.ctx, { code: "X", name: "X", category: "OTHER", delivery: "ONLINE" }),
      "FORBIDDEN",
    );
    await expectAppError(listSessions(cookA.ctx), "FORBIDDEN"); // a cashier has no training access
    const { ctx: other } = await createTenant("learning-other");
    const s = (await listSessions(ctx)).sessions[0];
    await expectAppError(getSession(other, s.id), "NOT_FOUND");
  });
});
