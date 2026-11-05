import { Decimal } from "@/lib/decimal";
import { roundToCurrency } from "@/modules/tax/rules";

/**
 * Payroll arithmetic (DECISIONS.md ADR-123). Pure. No statutory rate is
 * built in: contribution rates, bases and caps come from rules the
 * organization enters for each company's country, dated (Q-20).
 */

export const PRORATION_BASES = ["CALENDAR_DAYS", "THIRTY_DAYS"] as const;
export type ProrationBasis = (typeof PRORATION_BASES)[number];

export const APPLIES_TO = ["ALL", "NATIONALS", "NON_NATIONALS"] as const;
export type AppliesTo = (typeof APPLIES_TO)[number];

export const ADJUSTMENT_CATEGORIES = {
  ADDITION: ["OVERTIME", "BONUS", "COMMISSION", "OTHER_ADDITION"],
  DEDUCTION: ["ADVANCE_RECOVERY", "INCOME_TAX", "PENALTY", "OTHER_DEDUCTION"],
} as const;

const ZERO = new Decimal(0);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const dayCount = (from: string, to: string) => Math.round((ms(to) - ms(from)) / 86_400_000) + 1;

/** First and last day of a pay month (YYYY-MM). */
export function periodBounds(period: string): { start: string; end: string; days: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new RangeError("Period must be YYYY-MM");
  const [y, m] = period.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(days).padStart(2, "0")}`, days };
}

/** Days two closed date ranges share (0 when they do not meet). */
export function overlapDays(aFrom: string, aTo: string, bFrom: string, bTo: string): number {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  return from > to ? 0 : dayCount(from, to);
}

/**
 * Days paid in the month. On calendar days the month has its own length; on
 * a 30-day month every month counts 30 and days not employed come off it.
 */
export function paidDays(input: {
  basis: ProrationBasis;
  period: string;
  hireDate: string;
  terminatedOn: string | null;
}): { basisDays: number; paidDays: number } {
  const p = periodBounds(input.period);
  const employed = overlapDays(p.start, p.end, input.hireDate, input.terminatedOn ?? p.end);
  if (input.basis === "CALENDAR_DAYS") return { basisDays: p.days, paidDays: employed };
  return { basisDays: 30, paidDays: Math.max(0, 30 - (p.days - employed)) };
}

/**
 * Unpaid leave days in the month: each request's days (half days included)
 * counted in proportion to the calendar days it spends in the month.
 */
export function unpaidDaysIn(
  period: string,
  requests: ReadonlyArray<{ startDate: string; endDate: string; days: Decimal }>,
): Decimal {
  const p = periodBounds(period);
  return requests.reduce((sum, r) => {
    const span = dayCount(r.startDate, r.endDate);
    const inside = overlapDays(p.start, p.end, r.startDate, r.endDate);
    return inside === 0 ? sum : sum.plus(r.days.times(inside).dividedBy(span));
  }, ZERO);
}

export function ruleApplies(
  appliesTo: AppliesTo,
  nationality: string | null,
  companyCountry: string | null,
): boolean {
  if (appliesTo === "ALL") return true;
  if (!companyCountry || !nationality) return false;
  return appliesTo === "NATIONALS"
    ? nationality === companyCountry
    : nationality !== companyCountry;
}

export interface SalaryInput {
  basic: Decimal;
  items: ReadonlyArray<{
    code: string;
    name: string;
    amount: Decimal;
    inContributionBase: boolean;
  }>;
}

export interface ContributionRuleInput {
  id: string;
  code: string;
  name: string;
  employeeRate: Decimal;
  employerRate: Decimal;
  baseMin: Decimal | null;
  baseMax: Decimal | null;
}

export interface AdjustmentInput {
  kind: "ADDITION" | "DEDUCTION";
  category: string;
  amount: Decimal;
}

export interface PayrollLineResult {
  basisDays: number;
  paidDays: number;
  unpaidLeaveDays: Decimal;
  components: Array<{ code: string; name: string; amount: Decimal }>;
  fixedPay: Decimal;
  additions: Decimal;
  gross: Decimal;
  unpaidLeaveDeduction: Decimal;
  contributions: Array<{
    ruleId: string;
    code: string;
    name: string;
    base: Decimal;
    employee: Decimal;
    employer: Decimal;
  }>;
  employeeContributions: Decimal;
  employerContributions: Decimal;
  otherDeductions: Decimal;
  totalDeductions: Decimal;
  net: Decimal;
  /** What the month costs the employer: pay after unpaid leave plus employer contributions. */
  employerCost: Decimal;
}

/**
 * One employee's month. Fixed pay is prorated by paid days; unpaid leave
 * comes off at the daily rate of fixed pay; contributions are on the
 * contribution base (basic and the items marked for it) for the days
 * actually paid, held within the rule's minimum and maximum. Every amount
 * is rounded to the currency's smallest unit.
 */
export function computeLine(input: {
  currency: string;
  basisDays: number;
  paidDays: number;
  unpaidLeaveDays: Decimal;
  salary: SalaryInput;
  rules: readonly ContributionRuleInput[];
  adjustments: readonly AdjustmentInput[];
}): PayrollLineResult {
  const round = (v: Decimal) => roundToCurrency(v, input.currency);
  const share = new Decimal(input.paidDays).dividedBy(input.basisDays);
  const prorate = (v: Decimal) =>
    input.paidDays === input.basisDays ? round(v) : round(v.times(share));
  const components = [
    { code: "BASIC", name: "Basic", amount: prorate(input.salary.basic) },
    ...input.salary.items.map((i) => ({ code: i.code, name: i.name, amount: prorate(i.amount) })),
  ];
  const fixedPay = components.reduce((a, c) => a.plus(c.amount), ZERO);
  const monthlyFixed = input.salary.items.reduce((a, i) => a.plus(i.amount), input.salary.basic);
  const unpaid = Decimal.min(input.unpaidLeaveDays, input.paidDays);
  const unpaidLeaveDeduction = Decimal.min(
    round(monthlyFixed.dividedBy(input.basisDays).times(unpaid)),
    fixedPay,
  );

  const contributionMonthly = input.salary.items
    .filter((i) => i.inContributionBase)
    .reduce((a, i) => a.plus(i.amount), input.salary.basic);
  const workedShare = new Decimal(input.paidDays).minus(unpaid).dividedBy(input.basisDays);
  const contributionBase = contributionMonthly.times(workedShare);
  const contributions = input.rules.map((r) => {
    let base = contributionBase;
    if (r.baseMin && base.lt(r.baseMin) && base.gt(0)) base = r.baseMin;
    if (r.baseMax && base.gt(r.baseMax)) base = r.baseMax;
    base = round(base);
    return {
      ruleId: r.id,
      code: r.code,
      name: r.name,
      base,
      employee: round(base.times(r.employeeRate)),
      employer: round(base.times(r.employerRate)),
    };
  });
  const employeeContributions = contributions.reduce((a, c) => a.plus(c.employee), ZERO);
  const employerContributions = contributions.reduce((a, c) => a.plus(c.employer), ZERO);
  const sumOf = (kind: AdjustmentInput["kind"]) =>
    input.adjustments
      .filter((a) => a.kind === kind)
      .reduce((s, a) => s.plus(round(a.amount)), ZERO);
  const additions = sumOf("ADDITION");
  const otherDeductions = sumOf("DEDUCTION");
  const gross = fixedPay.plus(additions);
  const totalDeductions = unpaidLeaveDeduction.plus(employeeContributions).plus(otherDeductions);
  return {
    basisDays: input.basisDays,
    paidDays: input.paidDays,
    unpaidLeaveDays: unpaid,
    components,
    fixedPay,
    additions,
    gross,
    unpaidLeaveDeduction,
    contributions,
    employeeContributions,
    employerContributions,
    otherDeductions,
    totalDeductions,
    net: gross.minus(totalDeductions),
    employerCost: gross.minus(unpaidLeaveDeduction).plus(employerContributions),
  };
}
