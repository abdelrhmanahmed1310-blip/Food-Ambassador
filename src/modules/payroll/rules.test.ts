import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  computeLine,
  overlapDays,
  paidDays,
  periodBounds,
  ruleApplies,
  unpaidDaysIn,
  type ContributionRuleInput,
} from "./rules";

const d = (v: string | number) => new Decimal(v);
/** Made-up rates for testing the arithmetic only — not any country's law. */
const rule = (over: Partial<ContributionRuleInput> = {}): ContributionRuleInput => ({
  id: "r1",
  code: "TEST",
  name: "Test scheme",
  employeeRate: d("0.1"),
  employerRate: d("0.12"),
  baseMin: null,
  baseMax: null,
  ...over,
});

describe("periods and days", () => {
  it("bounds a month, leap years included", () => {
    expect(periodBounds("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29", days: 29 });
    expect(() => periodBounds("2026-13")).toThrow(RangeError);
    expect(overlapDays("2026-11-01", "2026-11-30", "2026-11-25", "2026-12-05")).toBe(6);
    expect(overlapDays("2026-11-01", "2026-11-30", "2026-12-01", "2026-12-05")).toBe(0);
  });

  it("pays calendar days or a 30-day month", () => {
    const join = { period: "2026-02", hireDate: "2026-02-15", terminatedOn: null };
    expect(paidDays({ basis: "CALENDAR_DAYS", ...join })).toEqual({ basisDays: 28, paidDays: 14 });
    // 30-day month: 30 less the 14 days not yet employed.
    expect(paidDays({ basis: "THIRTY_DAYS", ...join })).toEqual({ basisDays: 30, paidDays: 16 });
    const full = { period: "2026-03", hireDate: "2020-01-01", terminatedOn: null };
    expect(paidDays({ basis: "THIRTY_DAYS", ...full }).paidDays).toBe(30); // 31-day month
    const leaver = { period: "2026-03", hireDate: "2020-01-01", terminatedOn: "2026-03-10" };
    expect(paidDays({ basis: "CALENDAR_DAYS", ...leaver }).paidDays).toBe(10);
    expect(paidDays({ basis: "THIRTY_DAYS", ...leaver }).paidDays).toBe(9);
    const gone = { period: "2026-04", hireDate: "2020-01-01", terminatedOn: "2026-03-10" };
    expect(paidDays({ basis: "CALENDAR_DAYS", ...gone }).paidDays).toBe(0);
  });

  it("counts unpaid leave inside the month, half days kept", () => {
    expect(
      unpaidDaysIn("2026-11", [
        { startDate: "2026-11-10", endDate: "2026-11-11", days: d("1.5") },
        // Four days across the month end: two of them in November.
        { startDate: "2026-11-29", endDate: "2026-12-02", days: d("4") },
      ]).toFixed(),
    ).toBe("3.5");
  });

  it("applies rules to nationals, others or everyone", () => {
    expect(ruleApplies("ALL", null, null)).toBe(true);
    expect(ruleApplies("NATIONALS", "SA", "SA")).toBe(true);
    expect(ruleApplies("NATIONALS", "EG", "SA")).toBe(false);
    expect(ruleApplies("NON_NATIONALS", "EG", "SA")).toBe(true);
    // Without a nationality or company country a targeted rule never applies.
    expect(ruleApplies("NATIONALS", null, "SA")).toBe(false);
    expect(ruleApplies("NON_NATIONALS", "EG", null)).toBe(false);
  });
});

describe("computeLine", () => {
  const salary = {
    basic: d("6000"),
    items: [
      { code: "HOUSING", name: "Housing", amount: d("1500"), inContributionBase: true },
      { code: "TRANSPORT", name: "Transport", amount: d("500"), inContributionBase: false },
    ],
  };

  it("pays a full month with contributions on the contribution base", () => {
    const l = computeLine({
      currency: "SAR",
      basisDays: 30,
      paidDays: 30,
      unpaidLeaveDays: d(0),
      salary,
      rules: [rule()],
      adjustments: [{ kind: "ADDITION", category: "OVERTIME", amount: d("250") }],
    });
    expect(l.components.map((c) => c.amount.toFixed())).toEqual(["6000", "1500", "500"]);
    expect([l.fixedPay, l.gross, l.contributions[0].base].map((v) => v.toFixed())).toEqual([
      "8000",
      "8250",
      "7500",
    ]);
    expect(
      [l.employeeContributions, l.employerContributions, l.net, l.employerCost].map((v) =>
        v.toFixed(),
      ),
    ).toEqual(["750", "900", "7500", "9150"]);
  });

  it("prorates a joiner, takes off unpaid leave, and rounds to the currency", () => {
    const l = computeLine({
      currency: "KWD", // three decimals
      basisDays: 31,
      paidDays: 10,
      unpaidLeaveDays: d("1"),
      salary: { basic: d("1000"), items: [] },
      rules: [rule({ employeeRate: d("0.075"), employerRate: d("0") })],
      adjustments: [{ kind: "DEDUCTION", category: "ADVANCE_RECOVERY", amount: d("20") }],
    });
    expect(l.fixedPay.toFixed()).toBe("322.581"); // 1000 × 10 / 31
    expect(l.unpaidLeaveDeduction.toFixed()).toBe("32.258"); // one day's pay
    expect(l.contributions[0].base.toFixed()).toBe("290.323"); // 9 days worked
    expect(l.employeeContributions.toFixed()).toBe("21.774");
    expect(l.net.toFixed()).toBe("248.549"); // 322.581 − 32.258 − 21.774 − 20
  });

  it("holds the contribution base within the rule's limits", () => {
    const base = (min: string | null, max: string | null, basic: string) =>
      computeLine({
        currency: "SAR",
        basisDays: 30,
        paidDays: 30,
        unpaidLeaveDays: d(0),
        salary: { basic: d(basic), items: [] },
        rules: [rule({ baseMin: min ? d(min) : null, baseMax: max ? d(max) : null })],
        adjustments: [],
      }).contributions[0].base.toFixed();
    expect(base(null, "45000", "60000")).toBe("45000");
    expect(base("1500", null, "1000")).toBe("1500");
    expect(base(null, null, "1000")).toBe("1000");
  });

  it("can go negative, for the service to refuse at approval", () => {
    const l = computeLine({
      currency: "EGP",
      basisDays: 30,
      paidDays: 30,
      unpaidLeaveDays: d(0),
      salary: { basic: d("100"), items: [] },
      rules: [],
      adjustments: [{ kind: "DEDUCTION", category: "PENALTY", amount: d("150") }],
    });
    expect(l.net.toFixed()).toBe("-50");
  });
});
