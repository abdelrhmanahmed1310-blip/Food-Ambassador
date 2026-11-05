import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCommonLeaveTypes, decideLeave, listLeaveTypes, requestLeave } from "@/modules/hr/leave";
import { changeEmployeeStatus, createEmployee } from "@/modules/hr/service";
import {
  approvePayrollRun,
  createPayrollRun,
  setProrationBasis,
  setSalary,
} from "@/modules/payroll/service";
import {
  addApplication,
  decideOpening,
  hireCandidate,
  moveApplication,
  requestOpening,
} from "@/modules/recruitment/service";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { exportHrSeriesCsv, hrAnalytics, resolveRange } from "./service";

/** HR analytics over Jan–Mar 2026 (ADR-130). Pay figures are test values. */

let ctx: TenantContext;
let olayaMgr: TenantContext;
let olaya: string;
let malqa: string;
let companyId: string;
const RANGE = { from: "2026-01", to: "2026-03" };

beforeAll(async () => {
  ({ ctx } = await createTenant("hr-analytics", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  olaya = (await createBranch(ctx, { code: "OLY", name: "Olaya", type: "RESTAURANT" })).id;
  malqa = (await createBranch(ctx, { code: "MLQ", name: "Malqa", type: "RESTAURANT" })).id;
  companyId = (
    await getDb().branch.findUniqueOrThrow({ where: { id: olaya }, select: { companyId: true } })
  ).companyId;
  olayaMgr = (await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: olaya })).ctx;
  const hire = (first: string, branchId: string, hireDate: string) =>
    createEmployee(ctx, {
      firstName: first,
      lastName: "Test",
      jobTitle: "Cook",
      branchId,
      employmentType: "FULL_TIME",
      hireDate,
    });
  // Olaya: two in post all along, one who leaves in February; Malqa: one hired in March.
  const a = await hire("Ali", olaya, "2024-01-10");
  await hire("Badr", olaya, "2025-06-01");
  const c = await hire("Dana", olaya, "2025-09-01");
  await hire("Eman", malqa, "2026-03-05");
  await changeEmployeeStatus(ctx, c.id, {
    status: "TERMINATED",
    terminatedOn: "2026-02-14",
    reason: "Resigned",
  });
  // Ten days of unpaid leave for Ali, 5 of them in March.
  await addCommonLeaveTypes(ctx);
  const unpaid = (await listLeaveTypes(ctx)).find((t) => t.code === "UNPAID")!.id;
  const l = await requestLeave(ctx, a.id, {
    leaveTypeId: unpaid,
    startDate: "2026-03-27",
    endDate: "2026-04-05",
  });
  await decideLeave(ctx, l.id, { decision: "APPROVED" });
  // February payroll, approved by finance.
  await setProrationBasis(ctx, { prorationBasis: "THIRTY_DAYS" });
  await setSalary(ctx, a.id, {
    effectiveFrom: "2024-01-10",
    basic: "6000",
    payMethod: "CASH",
    items: [],
  });
  const run = await createPayrollRun(ctx, { companyId, period: "2026-02" });
  const finance = await addMember(ctx, "finance", {}, "hra-finance");
  await approvePayrollRun(finance.ctx, run.id);
}, 120_000);

afterAll(async () => {
  await getDb().$disconnect();
});

describe("HR analytics (ADR-130)", () => {
  it("defaults to the last twelve months, never past this month", () => {
    expect(resolveRange({}, "2026-11-05").months).toHaveLength(12);
    expect(resolveRange({ from: "2026-10", to: "2027-05" }, "2026-11-05").months).toEqual([
      "2026-10",
      "2026-11",
    ]);
    expect(resolveRange({ from: "bad" }, "2026-11-05").months[0]).toBe("2025-12");
  });

  it("works out headcount, turnover, tenure and absence for the range", async () => {
    const r = await hrAnalytics(ctx, RANGE);
    expect(r.series.map((m) => [m.month, m.start, m.end, m.hires, m.leavers])).toEqual([
      ["2026-01", 3, 3, 0, 0],
      ["2026-02", 3, 2, 0, 1],
      ["2026-03", 2, 3, 1, 0],
    ]);
    // Average (3 + 2.5 + 2.5) ÷ 3 = 2.67; one leaver → 37.5 %.
    expect(r.summary).toMatchObject({
      hires: 1,
      leavers: 1,
      averageHeadcount: 2.7,
      turnover: 37.5,
    });
    expect(r.people.byBranch).toEqual([
      { key: "MLQ", count: 1 },
      { key: "OLY", count: 2 },
    ]);
    expect(r.people.tenure).toEqual({ UNDER_3M: 1, "3_TO_12M": 1, "1_TO_3Y": 1, OVER_3Y: 0 });
    // 5 leave days in range over 2.67 people × 90 days.
    expect(r.absence).toMatchObject({ days: 5, rate: 2.1 });
    expect(r.absence.byType[0]).toMatchObject({ days: 5, paid: false });
    // Pay: February's approved run.
    expect(r.pay).toEqual([
      expect.objectContaining({ month: "2026-02", currency: "SAR", gross: "6000.00", people: 1 }),
    ]);
  });

  it("limits a branch manager to their branch, without pay", async () => {
    const r = await hrAnalytics(olayaMgr, RANGE);
    expect(r.branches.map((b) => b.code)).toEqual(["OLY"]);
    expect(r.summary).toMatchObject({ start: 3, end: 2, hires: 0, leavers: 1 });
    expect(r.pay).toBeNull();
    // Asking for another branch falls back to theirs.
    expect((await hrAnalytics(olayaMgr, { ...RANGE, branchId: malqa })).summary.end).toBe(2);
    const cashier = await addMember(ctx, "cashier", {}, "hra-cashier");
    await expectAppError(hrAnalytics(cashier.ctx, RANGE), "FORBIDDEN");
  });

  it("measures recruitment: time to hire, offer acceptance and source of hire", async () => {
    const o = await requestOpening(olayaMgr, {
      branchId: olaya,
      jobTitle: "Cook",
      employmentType: "FULL_TIME",
      headcount: "2",
      reason: "REPLACEMENT",
    });
    await decideOpening(ctx, o.id, { decision: "APPROVE" });
    const apply = async (first: string, source: string) => {
      const a = await addApplication(olayaMgr, o.id, {
        firstName: first,
        lastName: "Cand",
        source,
      });
      for (const to of ["SCREENING", "INTERVIEW", "OFFER"])
        await moveApplication(olayaMgr, a.id, { to });
      return a.id;
    };
    const sara = await apply("Sara", "REFERRAL");
    const omar = await apply("Omar", "JOB_BOARD");
    await hireCandidate(ctx, sara, { hireDate: "2026-03-01" });
    await moveApplication(olayaMgr, omar, { to: "WITHDRAWN", note: "Declined the offer" });
    // Place the approval and the offer outcomes inside the range.
    const db = getDb();
    await db.jobOpening.update({
      where: { id: o.id },
      data: { decidedAt: new Date("2026-02-01T09:00:00Z") },
    });
    await db.applicationEvent.updateMany({
      where: { applicationId: { in: [sara, omar] }, fromStage: "OFFER" },
      data: { at: new Date("2026-02-20T09:00:00Z") },
    });
    const r = (await hrAnalytics(ctx, RANGE)).recruitment!;
    expect(r).toMatchObject({
      openings: 1,
      places: 2,
      applicationsPerOpening: 2,
      hires: 1,
      offerAcceptance: 50,
      sources: [{ source: "REFERRAL", count: 1 }],
    });
    expect(r.timeToHire).toMatchObject({ count: 1, average: 28 });
    const csv = await exportHrSeriesCsv(ctx, RANGE);
    expect(csv.replace(/^﻿/, "").split("\r\n")[0]).toBe(
      "month,headcount_start,headcount_end,hires,leavers,turnover_percent",
    );
  });

  it("refuses another tenant's data by scoping, not by id", async () => {
    const { ctx: other } = await createTenant("hr-analytics-other");
    const r = await hrAnalytics(other, { ...RANGE, branchId: olaya });
    expect([r.branch, r.summary.end]).toEqual([null, 0]);
  });
});
