import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { addManualPunch } from "@/modules/hr/attendance";
import { addCommonLeaveTypes, decideLeave, listLeaveTypes, requestLeave } from "@/modules/hr/leave";
import { createEmployee } from "@/modules/hr/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import {
  addOvertimeToRun,
  createPayrollRun,
  getPayrollRun,
  removePayrollAdjustment,
  setProrationBasis,
  setSalary,
} from "@/modules/payroll/service";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addTemplateTask,
  createOnboardingTemplate,
  getChecklist,
  myOnboarding,
  setOnboardingTask,
  startOnboarding,
} from "./onboarding";
import { weekStart } from "./rules";
import {
  addShift,
  cancelShift,
  copyWeek,
  createShiftTemplate,
  decideOvertime,
  getShift,
  myRoster,
  publishWeek,
  removeShift,
  rosterWeek,
  setRosterSettings,
} from "./service";

/** Rosters, overtime into payroll, and onboarding (ADR-128). Rates here are test values. */

let ctx: TenantContext; // owner: HR and payroll
let olaya: string;
let malqa: string;
let companyId: string;
let olayaMgr: TenantContext;
let malqaMgr: TenantContext;
let mona: { id: string; ctx: TenantContext }; // a supervisor, Ali's line manager
let ali: { id: string; ctx: TenantContext };
let badr: { id: string; ctx: TenantContext };
let morning: string;
let aliShift: string;
let badrShift: string;
const today = businessDate("Asia/Riyadh");
const lastWeek = addDays(weekStart(today), -7);
const D = addDays(lastWeek, 2); // last week's Wednesday
const D2 = addDays(lastWeek, 3);

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

beforeAll(async () => {
  ({ ctx } = await createTenant("rosters", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  olaya = (await createBranch(ctx, { code: "OLY", name: "Olaya", type: "RESTAURANT" })).id;
  malqa = (await createBranch(ctx, { code: "MLQ", name: "Malqa", type: "RESTAURANT" })).id;
  companyId = (
    await getDb().branch.findUniqueOrThrow({ where: { id: olaya }, select: { companyId: true } })
  ).companyId;
  olayaMgr = (await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: olaya })).ctx;
  malqaMgr = (await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: malqa })).ctx;
  const person = async (first: string, managerId?: string) => {
    const m = await addMember(ctx, "cashier", {}, `roster-${first.toLowerCase()}`);
    const e = await createEmployee(ctx, {
      firstName: first,
      lastName: "Test",
      jobTitle: "Cook",
      branchId: olaya,
      employmentType: "FULL_TIME",
      hireDate: "2025-01-01",
      userId: m.user.id,
      ...(managerId ? { managerId } : {}),
    });
    return { id: e.id, ctx: m.ctx };
  };
  mona = await person("Mona");
  ali = await person("Ali", mona.id);
  badr = await person("Badr");
  await setProrationBasis(ctx, { prorationBasis: "THIRTY_DAYS" });
  await setSalary(ctx, ali.id, {
    effectiveFrom: "2025-01-01",
    basic: "7200",
    payMethod: "CASH",
    items: [{ code: "HOUSING", name: "Housing", amount: "1800" }],
  });
}, 120_000);

afterAll(async () => {
  await getDb().$disconnect();
});

describe("roster settings and shift templates (ADR-128)", () => {
  it("are entered by organization-wide HR; overtime pay needs multiplier and base together", async () => {
    await expectAppError(
      setRosterSettings(olayaMgr, { graceMinutes: "5", overtimeMinimumMinutes: "15" }),
      "FORBIDDEN",
    );
    await expectAppError(
      setRosterSettings(ctx, {
        graceMinutes: "5",
        overtimeMinimumMinutes: "15",
        standardDailyHours: "8",
        overtimeMultiplier: "1.5",
        overtimeBase: "",
      }),
      "VALIDATION_FAILED",
    );
    await setRosterSettings(ctx, {
      graceMinutes: "5",
      overtimeMinimumMinutes: "15",
      standardDailyHours: "8",
      overtimeMultiplier: "1.5",
      overtimeBase: "BASIC",
    });
    morning = (
      await createShiftTemplate(ctx, {
        code: "AM",
        name: "Morning",
        startTime: "09:00",
        endTime: "17:00",
        breakMinutes: "60",
      })
    ).id;
    await expectAppError(
      createShiftTemplate(ctx, {
        code: "am",
        name: "Again",
        startTime: "08:00",
        endTime: "12:00",
        breakMinutes: "0",
      }),
      "CONFLICT",
    );
    await expectRule(
      createShiftTemplate(ctx, {
        code: "SHORT",
        name: "Short",
        startTime: "09:00",
        endTime: "10:00",
        breakMinutes: "60",
      }),
      "SHIFT_BREAK_TOO_LONG",
    );
  });
});

describe("shifts (ADR-128)", () => {
  it("are planned by the branch's manager, without overlaps or leave", async () => {
    const plan = (who: TenantContext, employeeId: string, day: string, extra = {}) =>
      addShift(who, { employeeId, branchId: olaya, day, templateId: morning, ...extra });
    await expectAppError(plan(malqaMgr, ali.id, D), "FORBIDDEN");
    aliShift = (await plan(olayaMgr, ali.id, D)).id;
    badrShift = (await plan(olayaMgr, badr.id, D)).id;
    await expectRule(
      plan(olayaMgr, ali.id, D, { templateId: "", startTime: "16:00", endTime: "20:00" }),
      "SHIFT_OVERLAP",
    );
    // A night shift ending next morning is fine after a day shift.
    await plan(olayaMgr, ali.id, D2, {
      templateId: "",
      startTime: "22:00",
      endTime: "06:00",
      breakMinutes: "30",
    });
    await addCommonLeaveTypes(ctx);
    const annual = (await listLeaveTypes(ctx)).find((t) => t.code === "UNPAID")!.id;
    const leave = await requestLeave(ctx, badr.id, {
      leaveTypeId: annual,
      startDate: D2,
      endDate: D2,
    });
    await decideLeave(ctx, leave.id, { decision: "APPROVED" });
    await expectRule(plan(olayaMgr, badr.id, D2), "SHIFT_ON_LEAVE");

    // Drafts are not shown to staff until published.
    expect((await myRoster(ali.ctx))?.shifts).toEqual([]);
    expect((await publishWeek(olayaMgr, { branchId: olaya, week: D })).count).toBe(3);
    await expectRule(
      publishWeek(olayaMgr, { branchId: olaya, week: D }),
      "ROSTER_NOTHING_TO_PUBLISH",
    );
    expect((await myRoster(ali.ctx))?.shifts.map((s) => s.startTime)).toEqual(["09:00", "22:00"]);
    await expectRule(removeShift(olayaMgr, aliShift), "SHIFT_PUBLISHED");
  });

  it("compares with clock-ins: lateness, overtime and no-shows", async () => {
    const punch = (kind: "IN" | "OUT", date: string, time: string) =>
      addManualPunch(ctx, ali.id, { kind, date, time, reason: "Test" });
    await punch("IN", D, "09:20");
    await punch("OUT", D, "18:30");
    const a = await getShift(ctx, aliShift);
    // 09:20–18:30 less a 60-minute break = 490 worked; 420 planned → 70 overtime.
    expect(a.comparison).toMatchObject({
      outcome: "EXCEPTION",
      lateMinutes: 20,
      earlyMinutes: 0,
      workedMinutes: 490,
      overtimeMinutes: 70,
    });
    expect((await getShift(ctx, badrShift)).comparison?.outcome).toBe("NO_SHOW");
    // Ali sees his own shift; not other people's.
    expect((await getShift(ali.ctx, aliShift)).can.manage).toBe(false);
    await expectAppError(getShift(ali.ctx, badrShift), "NOT_FOUND");
  });

  it("lets a manager decide on overtime once, up to what was measured", async () => {
    await expectRule(decideOvertime(olayaMgr, badrShift, { decision: "APPROVE" }), "OVERTIME_NONE");
    await expectRule(
      decideOvertime(olayaMgr, aliShift, { decision: "APPROVE", minutes: "90" }),
      "OVERTIME_TOO_MANY",
    );
    await expectAppError(decideOvertime(malqaMgr, aliShift, { decision: "APPROVE" }), "FORBIDDEN");
    await decideOvertime(olayaMgr, aliShift, { decision: "APPROVE", minutes: "60", note: "Rush" });
    await expectAppError(decideOvertime(olayaMgr, aliShift, { decision: "REJECT" }), "CONFLICT");
    await expectRule(cancelShift(olayaMgr, aliShift, { reason: "x" }), "SHIFT_HAS_OVERTIME");
    await cancelShift(olayaMgr, badrShift, { reason: "Sick, called in" });
    // The decision itself cannot be rewritten in the database.
    await expect(
      getDb().overtimeDecision.updateMany({ where: { shiftId: aliShift }, data: { minutes: 70 } }),
    ).rejects.toThrow();
  });

  it("totals the week, with labour cost only for those who see pay", async () => {
    const week = (await rosterWeek(ctx, { branchId: olaya, week: D }))!;
    // Ali: 420 + 450 planned (Badr's cancelled shift not counted).
    expect(week.totals).toMatchObject({ plannedMinutes: 870, workedMinutes: 490 });
    // 9000 gross / (30 × 8) = 37.5 an hour: 870 min = 543.75; 490 min = 306.25.
    expect(week.totals.cost).toMatchObject({
      currency: "SAR",
      planned: "543.75",
      worked: "306.25",
    });
    expect((await rosterWeek(olayaMgr, { branchId: olaya, week: D }))!.totals.cost).toBeNull();
    // A Malqa manager sees only Malqa.
    expect((await rosterWeek(malqaMgr, { branchId: olaya }))!.branch.code).toBe("MLQ");
  });

  it("copies a week as drafts, skipping cancelled shifts", async () => {
    const r = await copyWeek(olayaMgr, { branchId: olaya, week: today, fromWeek: D });
    expect(r).toEqual({ copied: 2, skipped: 0 });
    const again = await copyWeek(olayaMgr, { branchId: olaya, week: today, fromWeek: D });
    expect(again).toEqual({ copied: 0, skipped: 2 });
    expect((await rosterWeek(ctx, { branchId: olaya, week: today }))!.drafts).toBe(2);
  });
});

describe("approved overtime in payroll (ADR-128)", () => {
  it("becomes an overtime addition once, and is freed if removed", async () => {
    const run = await createPayrollRun(ctx, { companyId, period: D.slice(0, 7) });
    expect(await addOvertimeToRun(ctx, run.id)).toEqual({ added: 1 });
    const adj = () =>
      getDb().payrollAdjustment.findMany({ where: { runId: run.id, category: "OVERTIME" } });
    // Basic 7200 / (30 × 8) = 30 an hour × 1.5 × 1 hour = 45.
    expect((await adj()).map((a) => a.amount.toFixed(2))).toEqual(["45.00"]);
    expect(await addOvertimeToRun(ctx, run.id)).toEqual({ added: 0 });
    const line = (await getPayrollRun(ctx, run.id)).lines.find((l) => l.employeeId === ali.id)!;
    expect(line.gross.toFixed(2)).toBe("9045.00");
    await removePayrollAdjustment(ctx, (await adj())[0].id);
    expect(await addOvertimeToRun(ctx, run.id)).toEqual({ added: 1 });
    await expectAppError(addOvertimeToRun(olayaMgr, run.id), "FORBIDDEN");
  });
});

describe("onboarding checklists (ADR-128)", () => {
  it("copies a template's tasks for a new hire; each is ticked by whom it is for", async () => {
    await expectAppError(
      createOnboardingTemplate(olayaMgr, { code: "NEW", name: "x" }),
      "FORBIDDEN",
    );
    const t = await createOnboardingTemplate(ctx, { code: "NEW", name: "New starter" });
    await expectRule(startOnboarding(ctx, ali.id, { templateId: t.id }), "ONBOARDING_NO_TASKS");
    await addTemplateTask(ctx, t.id, { title: "Contract signed", dueDays: "0", assignee: "HR" });
    await addTemplateTask(ctx, t.id, { title: "Kitchen tour", dueDays: "1", assignee: "MANAGER" });
    await addTemplateTask(ctx, t.id, {
      title: "Read the handbook",
      dueDays: "3",
      assignee: "EMPLOYEE",
    });
    await expectAppError(startOnboarding(olayaMgr, ali.id, { templateId: t.id }), "FORBIDDEN");
    const c = await startOnboarding(ctx, ali.id, {
      templateId: t.id,
      startedOn: addDays(today, -10),
    });
    await expectAppError(startOnboarding(ctx, ali.id, { templateId: t.id }), "CONFLICT");
    expect((await attentionItems(ctx)).find((i) => i.key === "ONBOARDING_OVERDUE")?.count).toBe(3);
    expect(
      (await attentionItems(ali.ctx)).find((i) => i.key === "ONBOARDING_TASKS_MINE")?.count,
    ).toBe(1);

    const tasks = (await getChecklist(ali.ctx, c.id)).tasks;
    expect(tasks.map((x) => [x.assignee, x.mayTick, x.overdue])).toEqual([
      ["HR", false, true],
      ["MANAGER", false, true],
      ["EMPLOYEE", true, true],
    ]);
    await expectAppError(setOnboardingTask(ali.ctx, tasks[0].id, { done: true }), "FORBIDDEN");
    await setOnboardingTask(ali.ctx, tasks[2].id, { done: true });
    expect((await myOnboarding(mona.ctx)).checklists.map((x) => x.own)).toEqual([false]);
    await setOnboardingTask(mona.ctx, tasks[1].id, { done: true, note: "Done with Mona" });
    await expectAppError(getChecklist(badr.ctx, c.id), "NOT_FOUND");
    expect(await setOnboardingTask(ctx, tasks[0].id, { done: true })).toMatchObject({
      completed: true,
    });
    await expectRule(setOnboardingTask(ctx, tasks[0].id, { done: false }), "ONBOARDING_CLOSED");
    const { ctx: other } = await createTenant("rosters-other");
    await expectAppError(getChecklist(other, c.id), "NOT_FOUND");
  });
});
