import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { branchPnl } from "@/modules/finance/pnl";
import { changeEmployeeStatus, createEmployee } from "@/modules/hr/service";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { endOfService } from "./rules";
import {
  addEosRule,
  addPayrollAdjustment,
  addTaxTable,
  approvePayrollRun,
  createPayrollRun,
  getPayrollRun,
  listTaxAndEosRules,
  setProrationBasis,
  setSalary,
  settleEndOfService,
} from "./service";

/**
 * Income tax, end of service, salary splits and payroll in the P&L
 * (ADR-124). All rates and tiers here are made up to test the arithmetic.
 */

const Y = new Date().getUTCFullYear() + 1;
const MAR = `${Y}-03`;
let ctx: TenantContext;
let finance: TenantContext;
let companyId: string;
let branchId: string;
let dana: string; // raise mid-March
let emad: string; // resigns on 10 March
let march: string;

const d = (v: string | number) => new Decimal(v);
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
const lineOf = async (runId: string, employeeId: string) =>
  (await getPayrollRun(ctx, runId)).lines.find((l) => l.employeeId === employeeId)!;
const EOS_TEST = {
  id: "x",
  code: "TEST_EOS",
  name: "Test",
  tiers: [
    { fromYears: d(0), monthsPerYear: d("0.5") },
    { fromYears: d(5), monthsPerYear: d(1) },
  ],
  resignation: [
    { fromYears: d(0), factor: d(0) },
    { fromYears: d(2), factor: d("0.5") },
    { fromYears: d(10), factor: d(1) },
  ],
  capMonths: null,
};

beforeAll(async () => {
  ({ ctx } = await createTenant("payroll-rules", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  finance = (await addMember(ctx, "finance")).ctx;
  branchId = (await createBranch(ctx, { code: "RUH", name: "Olaya", type: "RESTAURANT" })).id;
  companyId = (
    await getDb().branch.findUniqueOrThrow({ where: { id: branchId }, select: { companyId: true } })
  ).companyId;
  await getDb().company.update({ where: { id: companyId }, data: { country: "SA" } });
  const hire = async (first: string, hireDate: string) =>
    (
      await createEmployee(ctx, {
        firstName: first,
        lastName: "Test",
        jobTitle: "Cook",
        branchId,
        employmentType: "FULL_TIME",
        hireDate,
        nationality: "SA",
      })
    ).id;
  dana = await hire("Dana", "2019-01-01");
  emad = await hire("Emad", `${Y - 5}-01-01`);
  const housing = (amount: string) => ({
    code: "HOUSING",
    name: "Housing",
    amount,
    inEosBase: "on",
  });
  await setSalary(ctx, dana, {
    effectiveFrom: "2025-01-01",
    basic: "6000",
    payMethod: "CASH",
    items: [housing("1500")],
  });
  await setSalary(ctx, dana, {
    effectiveFrom: `${MAR}-16`,
    basic: "9000",
    payMethod: "CASH",
    items: [housing("1500")],
  });
  await setSalary(ctx, emad, { effectiveFrom: `${Y - 5}-01-01`, basic: "4000", payMethod: "CASH" });
  await setProrationBasis(ctx, { prorationBasis: "THIRTY_DAYS" });
}, 120_000);

afterAll(async () => {
  await getDb().$disconnect();
});

describe("entered income tax and end-of-service rules (ADR-124)", () => {
  it("takes tax tables with bands and brackets, and refuses overlaps", async () => {
    const table = {
      companyId,
      code: "TEST_TAX",
      name: "Test tax",
      appliesTo: "ALL",
      annualExemption: "0",
      effectiveFrom: "2026-01-01",
      source: "Test values",
      bands: [
        {
          upTo: "",
          brackets: [
            { upTo: "60000", ratePercent: "0" },
            { upTo: "", ratePercent: "10" },
            { upTo: "", ratePercent: "" }, // an empty form row
          ],
        },
      ],
    };
    // Brackets must rise and end open.
    await expectAppError(
      addTaxTable(ctx, {
        ...table,
        bands: [
          {
            upTo: "",
            brackets: [
              { upTo: "60000", ratePercent: "0" },
              { upTo: "50000", ratePercent: "10" },
            ],
          },
        ],
      }),
      "VALIDATION_FAILED",
    );
    await addTaxTable(ctx, table);
    await expectRule(
      addTaxTable(ctx, { ...table, code: "OTHER_TAX", appliesTo: "NATIONALS" }),
      "RULE_OVERLAP",
    );
    await expectAppError(
      addEosRule(ctx, {
        companyId,
        code: "TEST_EOS",
        name: "Test",
        appliesTo: "ALL",
        base: "EOS_BASE",
        effectiveFrom: "2026-01-01",
        source: "Test values",
        tiers: [{ fromYears: "1", monthsPerYear: "0.5" }],
      }),
      "VALIDATION_FAILED", // tiers start at 0 years
    );
    await addEosRule(ctx, {
      companyId,
      code: "TEST_EOS",
      name: "Test",
      appliesTo: "ALL",
      base: "EOS_BASE",
      effectiveFrom: "2026-01-01",
      source: "Test values",
      tiers: [
        { fromYears: "0", monthsPerYear: "0.5" },
        { fromYears: "5", monthsPerYear: "1" },
      ],
      resignation: [
        { fromYears: "0", factorPercent: "0" },
        { fromYears: "2", factorPercent: "50" },
        { fromYears: "10", factorPercent: "100" },
      ],
    });
    const rules = await listTaxAndEosRules(ctx);
    expect(
      rules.tax[0].input.bands[0].brackets.map((b) => [
        b.upTo?.toFixed() ?? null,
        b.rate.toFixed(),
      ]),
    ).toEqual([
      ["60000", "0"],
      [null, "0.1"],
    ]);
    expect(rules.eos[0].input.resignation.map((r) => r.factor.toFixed())).toEqual([
      "0",
      "0.5",
      "1",
    ]);
  });
});

describe("a month with a raise, tax, a leaver and accruals (ADR-124)", () => {
  it("pays each part of the month at its salary and takes the entered tax", async () => {
    await changeEmployeeStatus(ctx, emad, {
      status: "TERMINATED",
      terminatedOn: `${MAR}-10`,
      reason: "Resigned",
    });
    march = (await createPayrollRun(ctx, { companyId, period: MAR })).id;
    const l = await lineOf(march, dana);
    // 15 days at 7500 and 15 at 10500 on a 30-day month.
    expect(l.details.components.map((c) => [c.code, String(c.amount)])).toEqual([
      ["BASIC", "7500"],
      ["HOUSING", "1500"],
    ]);
    expect(l.details.segments!.map((s) => s.days)).toEqual([15, 15]);
    // 9000 × 12 = 108000; 10 % above 60000 = 4800 a year, 400 a month.
    expect([String(l.fixedPay), String(l.incomeTax), String(l.net)]).toEqual([
      "9000",
      "400",
      "8600",
    ]);
    // End of service owed at month end on basic + housing at the new salary; nothing accrued before.
    const due = endOfService({
      currency: "SAR",
      hireDate: "2019-01-01",
      asOf: `${MAR}-31`,
      monthlyBase: d("10500"),
      rule: EOS_TEST,
      resigned: false,
    });
    expect([String(l.eosLiability), String(l.eosAccrual)]).toEqual([
      due.amount.toFixed(),
      due.amount.toFixed(),
    ]);
  });

  it("settles a resignation at the rule's share, once, and keeps it out of tax", async () => {
    await expectRule(
      settleEndOfService(ctx, march, { employeeId: dana, reason: "RESIGNATION" }),
      "EOS_NOT_LEAVING",
    );
    await expectAppError(
      addPayrollAdjustment(ctx, march, {
        employeeId: emad,
        kind: "ADDITION",
        category: "END_OF_SERVICE",
        amount: "1",
      }),
      "VALIDATION_FAILED", // only through the settlement
    );
    const r = await settleEndOfService(ctx, march, { employeeId: emad, reason: "RESIGNATION" });
    const expected = endOfService({
      currency: "SAR",
      hireDate: `${Y - 5}-01-01`,
      asOf: `${MAR}-10`,
      monthlyBase: d("4000"),
      rule: EOS_TEST,
      resigned: true,
    });
    expect([r.factor.toFixed(), r.amount.toFixed()]).toEqual(["0.5", expected.amount.toFixed()]);
    await expectAppError(
      settleEndOfService(ctx, march, { employeeId: emad, reason: "RESIGNATION" }),
      "CONFLICT",
    );
    const l = await lineOf(march, emad);
    // 9 paid days on a 30-day basis (30 − 21 days not employed) at 4000; the settlement adds to pay
    // but not to taxable pay (14400 a year: no tax).
    expect([String(l.fixedPay), String(l.incomeTax)]).toEqual(["1200", "0"]);
    expect(String(l.net)).toBe(d("1200").plus(expected.amount).toFixed());
  });

  it("accrues the change in end of service month to month, and costs the P&L", async () => {
    await approvePayrollRun(finance, march);
    const april = (await createPayrollRun(ctx, { companyId, period: `${Y}-04` })).id;
    const m = await lineOf(march, dana);
    const a = await lineOf(april, dana);
    expect(String(a.eosAccrual)).toBe(
      d(a.eosLiability.toString()).minus(m.eosLiability.toString()).toFixed(),
    );
    expect(d(a.eosAccrual.toString()).gt(0)).toBe(true);

    // March staff cost: cost to employer plus accruals, less the settlement paid from them.
    const run = await getPayrollRun(ctx, march);
    const settlement = run.adjustments.find((x) => x.category === "END_OF_SERVICE")!;
    const expected = run.lines
      .reduce((s, l) => s.plus(l.employerCost.toString()).plus(l.eosAccrual.toString()), d(0))
      .minus(settlement.amount.toString());
    const pnl = await branchPnl(ctx, { from: `${MAR}-01`, to: `${MAR}-31` }, { branchId });
    const total = pnl.columns.find((c) => c.kind === "TOTAL")!;
    expect(total.values.STAFF.toFixed()).toBe(expected.toFixed());
    // The draft April run is not in the P&L.
    const apr = await branchPnl(ctx, { from: `${Y}-04-01`, to: `${Y}-04-30` }, { branchId });
    expect(apr.columns.find((c) => c.kind === "TOTAL")!.values.STAFF.toFixed()).toBe("0");
  });
});
