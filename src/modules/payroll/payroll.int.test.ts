import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCommonLeaveTypes, decideLeave, listLeaveTypes, requestLeave } from "@/modules/hr/leave";
import { createEmployee } from "@/modules/hr/service";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addContributionRule,
  addPayrollAdjustment,
  approvePayrollRun,
  cancelPayrollRun,
  createPayrollRun,
  employeePay,
  exportBankFileCsv,
  getPayrollRun,
  getPayslip,
  listPayrollRuns,
  markPayrollRunPaid,
  myPayslips,
  removePayrollAdjustment,
  setBankAccount,
  setProrationBasis,
  setSalary,
} from "./service";

/**
 * Payroll (ADR-123). The contribution rates here are made up to test the
 * arithmetic; no country's rates are built in.
 */

const Y = new Date().getUTCFullYear() + 1;
const P = `${Y}-03`; // 31 days
const IBAN = "SA0380000000608010167519"; // the published Saudi example
let ctx: TenantContext;
let companyId: string;
let ahmed: { id: string; ctx: TenantContext };
let bilal: { id: string; ctx: TenantContext };
let carla: string;
let runId: string;

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

const line = async (employeeId: string) =>
  (await getPayrollRun(ctx, runId)).lines.find((l) => l.employeeId === employeeId)!;

beforeAll(async () => {
  ({ ctx } = await createTenant("payroll", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  const branch = await createBranch(ctx, { code: "RUH", name: "Olaya", type: "RESTAURANT" });
  companyId = (
    await getDb().branch.findUniqueOrThrow({
      where: { id: branch.id },
      select: { companyId: true },
    })
  ).companyId;
  const person = async (first: string, nationality: string, hireDate: string) => {
    const m = await addMember(ctx, "cashier", {}, `payroll-${first.toLowerCase()}`);
    const e = await createEmployee(ctx, {
      firstName: first,
      lastName: "Test",
      jobTitle: "Cook",
      branchId: branch.id,
      employmentType: "FULL_TIME",
      hireDate,
      nationality,
      userId: m.user.id,
    });
    return { id: e.id, ctx: m.ctx };
  };
  ahmed = await person("Ahmed", "SA", "2026-01-01");
  bilal = await person("Bilal", "EG", `${Y}-03-17`);
  carla = (await person("Carla", "PH", "2026-01-01")).id;
  await addCommonLeaveTypes(ctx);
  const unpaid = (await listLeaveTypes(ctx)).find((t) => t.code === "UNPAID")!.id;
  const leave = await requestLeave(ctx, bilal.id, {
    leaveTypeId: unpaid,
    startDate: `${Y}-03-20`,
    endDate: `${Y}-03-21`,
  });
  await decideLeave(ctx, leave.id, { decision: "APPROVED" });
}, 120_000);

afterAll(async () => {
  await getDb().$disconnect();
});

describe("pay records (ADR-123)", () => {
  it("keeps dated salaries with allowances, and bank accounts sealed", async () => {
    await expectRule(
      setSalary(ctx, ahmed.id, {
        effectiveFrom: "2026-01-01",
        basic: "6000",
        payMethod: "BANK",
        items: [
          { code: "HOUSING", name: "Housing", amount: "1500" },
          { code: "housing", name: "Again", amount: "1" },
        ],
      }),
      "SALARY_ITEM_DUPLICATE",
    );
    await setSalary(ctx, ahmed.id, {
      effectiveFrom: "2026-01-01",
      basic: "5000",
      payMethod: "BANK",
      items: [],
    });
    // A raise is a new record from its date; the old one stays.
    await setSalary(ctx, ahmed.id, {
      effectiveFrom: `${Y}-01-01`,
      basic: "6000",
      payMethod: "BANK",
      items: [
        { code: "HOUSING", name: "Housing", amount: "1500", inContributionBase: "on" },
        { code: "TRANSPORT", name: "Transport", amount: "500" },
        { code: "", name: "", amount: "" }, // an empty form row
      ],
    });
    await expectAppError(
      setSalary(ctx, ahmed.id, { effectiveFrom: `${Y}-01-01`, basic: "1", payMethod: "BANK" }),
      "CONFLICT",
    );
    await setSalary(ctx, bilal.id, {
      effectiveFrom: `${Y}-03-17`,
      basic: "3100",
      payMethod: "CASH",
    });
    const pay = await employeePay(ctx, ahmed.id);
    expect(pay.salaries.map((s) => [s.effectiveFrom, s.total.toFixed()])).toEqual([
      [`${Y}-01-01`, "8000"],
      ["2026-01-01", "5000"],
    ]);

    await expectAppError(
      setBankAccount(ctx, ahmed.id, { bankName: "Bank", iban: "SA0380000000608010167518" }),
      "VALIDATION_FAILED",
    );
    await setBankAccount(ctx, ahmed.id, {
      bankName: "Al Bank",
      iban: "sa03 8000 0000 6080 1016 7519",
    });
    expect((await employeePay(ctx, ahmed.id)).bank?.ibanLast4).toBe("7519");
    const row = await getDb().employeeBankAccount.findFirstOrThrow({
      where: { employeeId: ahmed.id },
    });
    expect(row.ibanSealed).not.toContain("6080");
    // Records are never edited, and the audit holds no amounts or IBAN.
    await expect(
      getDb().employeeSalary.updateMany({ where: { employeeId: ahmed.id }, data: { basic: "1" } }),
    ).rejects.toThrow();
    const audits = JSON.stringify(
      await getDb().auditEvent.findMany({
        where: { organizationId: ctx.organizationId, action: { startsWith: "employee_" } },
      }),
    );
    expect(audits).not.toContain("6000");
    expect(audits).not.toContain(IBAN);
  });

  it("takes contribution rules as entered, dated, for the company's country", async () => {
    const rule = (over: Record<string, string> = {}) => ({
      companyId,
      code: "SCHEME_A",
      name: "Scheme A (test)",
      appliesTo: "NATIONALS",
      employeeRatePercent: "10",
      employerRatePercent: "12",
      baseMax: "45000",
      effectiveFrom: "2026-01-01",
      source: "Test values",
      ...over,
    });
    await expectRule(addContributionRule(ctx, rule()), "COMPANY_COUNTRY_REQUIRED");
    await getDb().company.update({ where: { id: companyId }, data: { country: "SA" } });
    await expectAppError(
      addContributionRule(ctx, rule({ employeeRatePercent: "0", employerRatePercent: "0" })),
      "VALIDATION_FAILED",
    );
    await addContributionRule(ctx, rule());
    await addContributionRule(
      ctx,
      rule({
        code: "SCHEME_B",
        appliesTo: "ALL",
        employeeRatePercent: "0",
        employerRatePercent: "1",
        baseMax: "",
      }),
    );
    // A new version of a rule ends the old one the day before.
    await addContributionRule(
      ctx,
      rule({
        code: "SCHEME_B",
        appliesTo: "ALL",
        employeeRatePercent: "0",
        employerRatePercent: "2",
        baseMax: "",
        effectiveFrom: `${Y}-01-01`,
      }),
    );
    await expectRule(
      addContributionRule(ctx, rule({ code: "SCHEME_B", effectiveFrom: "2026-06-01" })),
      "RULE_DATE_BEFORE_CURRENT",
    );
    const b = await getDb().payrollContributionRule.findMany({
      where: { organizationId: ctx.organizationId, code: "SCHEME_B" },
      orderBy: { effectiveFrom: "asc" },
    });
    expect(b[0].effectiveTo?.toISOString().slice(0, 10)).toBe(`${Y - 1}-12-31`);
  });
});

describe("payroll runs (ADR-123)", () => {
  it("needs a proration basis, then pays the month line by line", async () => {
    await expectRule(createPayrollRun(ctx, { companyId, period: P }), "PRORATION_BASIS_REQUIRED");
    await setProrationBasis(ctx, { prorationBasis: "THIRTY_DAYS" });
    runId = (await createPayrollRun(ctx, { companyId, period: P })).id;
    await expectAppError(createPayrollRun(ctx, { companyId, period: P }), "CONFLICT");

    const r = await getPayrollRun(ctx, runId);
    expect(r.skipped.map((s) => [s.employeeId, s.reason])).toEqual([[carla, "NO_SALARY"]]);
    const a = await line(ahmed.id);
    // Full month: 8000; scheme A on 7500 (basic + housing), scheme B employer 2 %.
    expect(
      [a.paidDays, a.fixedPay, a.employeeContributions, a.employerContributions, a.net].map(String),
    ).toEqual(["30", "8000", "750", "1050", "7250"]);
    expect(a.details.contributions.map((c) => [c.code, c.base, c.employee, c.employer])).toEqual([
      ["SCHEME_A", "7500", "750", "900"],
      ["SCHEME_B", "7500", "0", "150"],
    ]);
    // Bilal joined on the 17th (14 paid days of 30) and took 2 unpaid days; scheme A is for nationals.
    const b = await line(bilal.id);
    expect(
      [
        b.paidDays,
        b.unpaidLeaveDays,
        b.fixedPay,
        b.unpaidLeaveDeduction,
        b.employerContributions,
        b.net,
      ].map(String),
    ).toEqual(["14", "2", "1446.67", "206.67", "24.8", "1240"]);
    expect(String(r.run.net)).toBe("8490");
  });

  it("takes adjustments while a draft and refuses a negative net at approval", async () => {
    await addPayrollAdjustment(ctx, runId, {
      employeeId: ahmed.id,
      kind: "ADDITION",
      category: "OVERTIME",
      amount: "300",
    });
    expect(String((await line(ahmed.id)).net)).toBe("7550");
    await expectAppError(
      addPayrollAdjustment(ctx, runId, {
        employeeId: ahmed.id,
        kind: "ADDITION",
        category: "INCOME_TAX",
        amount: "1",
      }),
      "VALIDATION_FAILED",
    );
    await expectRule(
      addPayrollAdjustment(ctx, runId, {
        employeeId: carla,
        kind: "ADDITION",
        category: "BONUS",
        amount: "1",
      }),
      "EMPLOYEE_NOT_ON_RUN",
    );
    await addPayrollAdjustment(ctx, runId, {
      employeeId: bilal.id,
      kind: "DEDUCTION",
      category: "ADVANCE_RECOVERY",
      amount: "5000",
    });
    const finance = await addMember(ctx, "finance");
    await expectRule(approvePayrollRun(finance.ctx, runId), "PAYROLL_NEGATIVE_NET");
    const advance = (await getPayrollRun(ctx, runId)).adjustments.find(
      (x) => x.category === "ADVANCE_RECOVERY",
    )!;
    await removePayrollAdjustment(ctx, advance.id);
    // The preparer does not approve their own run.
    await expectRule(approvePayrollRun(ctx, runId), "PAYROLL_SELF_APPROVAL");
    await approvePayrollRun(finance.ctx, runId);
    const r = await getPayrollRun(ctx, runId);
    expect([r.run.status, String(r.run.net), String(r.run.employerCost)]).toEqual([
      "APPROVED",
      "8790",
      "10614.8",
    ]);
  });

  it("fixes an approved run and the month it pays", async () => {
    await expectRule(
      addPayrollAdjustment(ctx, runId, {
        employeeId: ahmed.id,
        kind: "ADDITION",
        category: "BONUS",
        amount: "1",
      }),
      "PAYROLL_RUN_NOT_DRAFT",
    );
    await expect(
      getDb().payrollLine.updateMany({ where: { runId }, data: { net: "1" } }),
    ).rejects.toThrow();
    await expect(
      getDb().payrollRun.update({ where: { id: runId }, data: { status: "DRAFT" } }),
    ).rejects.toThrow();
    await expectRule(
      setSalary(ctx, ahmed.id, { effectiveFrom: `${P}-15`, basic: "9000", payMethod: "BANK" }),
      "SALARY_PERIOD_SETTLED",
    );
  });

  it("exports the bank transfers and shows each person their own payslip", async () => {
    const csv = await exportBankFileCsv(ctx, runId);
    expect(csv).toContain(`Ahmed Test,Al Bank,${IBAN},7550,SAR`);
    expect(csv).not.toContain("Bilal"); // paid in cash
    const audit = await getDb().auditEvent.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, action: "payroll_run.bank_file_exported" },
    });
    expect(JSON.stringify(audit)).not.toContain(IBAN);

    const mine = await myPayslips(ahmed.ctx);
    expect(mine.map((m) => String(m.net))).toEqual(["7550"]);
    const slip = await getPayslip(ahmed.ctx, mine[0].id);
    expect(slip.final).toBe(true);
    expect(slip.adjustments.map((a) => a.category)).toEqual(["OVERTIME"]);
    await expectAppError(getPayslip(bilal.ctx, mine[0].id), "NOT_FOUND");

    await markPayrollRunPaid(ctx, runId, { paidOn: `${Y}-03-31` });
    await expectRule(cancelPayrollRun(ctx, runId, { reason: "Oops" }), "PAYROLL_RUN_CLOSED");
    expect((await listPayrollRuns(ctx)).runs[0].status).toBe("PAID");
  });

  it("is for payroll staff only, within the organization", async () => {
    const manager = await addMember(ctx, "branch_manager");
    await expectAppError(listPayrollRuns(manager.ctx), "FORBIDDEN");
    await expectAppError(employeePay(manager.ctx, ahmed.id), "FORBIDDEN");
    await expectAppError(getPayslip(manager.ctx, (await line(ahmed.id)).id), "NOT_FOUND");
    const { ctx: other } = await createTenant("payroll-other");
    await expectAppError(getPayrollRun(other, runId), "NOT_FOUND");
  });
});
