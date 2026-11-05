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
  ADDITION: ["OVERTIME", "BONUS", "COMMISSION", "OTHER_ADDITION", "END_OF_SERVICE"],
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
  range?: { from: string; to: string },
): Decimal {
  const p = periodBounds(period);
  const from = range && range.from > p.start ? range.from : p.start;
  const to = range && range.to < p.end ? range.to : p.end;
  return requests.reduce((sum, r) => {
    const span = dayCount(r.startDate, r.endDate);
    const inside = overlapDays(from, to, r.startDate, r.endDate);
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

/** Part of the month paid at one salary (a change within the month makes two). */
export interface SalarySegment {
  salary: SalaryInput;
  paidDays: number;
  unpaidLeaveDays: Decimal;
}

/**
 * Split the month at salary changes. Each salary covers the days employed
 * from its start (or the month's) to the next one's start; on a 30-day
 * month the last part takes up the difference so the parts add up to the
 * paid days.
 */
export function salarySegments(input: {
  period: string;
  basis: ProrationBasis;
  hireDate: string;
  terminatedOn: string | null;
  /** Salaries in force during the month, oldest first; the first may start before it. */
  salaries: ReadonlyArray<{ effectiveFrom: string }>;
}): Array<{ index: number; from: string; to: string; days: number }> {
  const p = periodBounds(input.period);
  const startEmployed = input.hireDate > p.start ? input.hireDate : p.start;
  const endEmployed = input.terminatedOn && input.terminatedOn < p.end ? input.terminatedOn : p.end;
  const parts: Array<{ index: number; from: string; to: string; days: number }> = [];
  input.salaries.forEach((s, index) => {
    const next = input.salaries[index + 1];
    const from = s.effectiveFrom > startEmployed ? s.effectiveFrom : startEmployed;
    const to = next ? addDay(next.effectiveFrom, -1) : endEmployed;
    const end = to < endEmployed ? to : endEmployed;
    if (from <= end) parts.push({ index, from, to: end, days: dayCount(from, end) });
  });
  const { paidDays: total } = paidDays({
    basis: input.basis,
    period: input.period,
    hireDate: input.hireDate,
    terminatedOn: input.terminatedOn,
  });
  let diff = total - parts.reduce((a, x) => a + x.days, 0);
  for (let k = parts.length - 1; k >= 0 && diff !== 0; k--) {
    const change = Math.max(-parts[k].days, diff);
    parts[k].days += change;
    diff -= change;
  }
  return parts;
}

function addDay(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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

// ─── Income tax (entered tables, ADR-124) ───

/** Brackets on annual taxable income: each rate applies up to its upper limit (the last has none). */
export interface TaxBracket {
  upTo: Decimal | null;
  rate: Decimal;
}

/** A band of annual taxable income with its own brackets (one band when the law has none). */
export interface TaxBand {
  upTo: Decimal | null;
  brackets: readonly TaxBracket[];
}

export interface TaxTableInput {
  id: string;
  code: string;
  name: string;
  annualExemption: Decimal;
  deductContributions: boolean;
  bands: readonly TaxBand[];
}

/** Progressive tax on an annual amount over brackets sorted by upper limit. */
export function bracketTax(annual: Decimal, brackets: readonly TaxBracket[]): Decimal {
  let tax = ZERO;
  let lower = ZERO;
  for (const b of brackets) {
    if (annual.lte(lower)) break;
    const top = b.upTo && annual.gt(b.upTo) ? b.upTo : annual;
    tax = tax.plus(top.minus(lower).times(b.rate));
    if (!b.upTo) break;
    lower = b.upTo;
  }
  return tax;
}

/**
 * This month's tax: the month's taxable pay as a year (×12), less the annual
 * exemption, taxed on the brackets of the band it falls in, divided by 12.
 */
export function monthlyIncomeTax(
  monthlyTaxable: Decimal,
  table: TaxTableInput,
): { annualTaxable: Decimal; annualTax: Decimal; band: number; monthly: Decimal } {
  const annualTaxable = Decimal.max(monthlyTaxable.times(12).minus(table.annualExemption), 0);
  let band = table.bands.findIndex((b) => !b.upTo || annualTaxable.lte(b.upTo));
  if (band < 0) band = table.bands.length - 1;
  const annualTax = band < 0 ? ZERO : bracketTax(annualTaxable, table.bands[band].brackets);
  return { annualTaxable, annualTax, band, monthly: annualTax.dividedBy(12) };
}

// ─── End of service (entered rules, ADR-124) ───

export interface EosRuleInput {
  id: string;
  code: string;
  name: string;
  /** Months of base pay earned per year of service, from each number of years on. */
  tiers: ReadonlyArray<{ fromYears: Decimal; monthsPerYear: Decimal }>;
  /** Share paid on resignation, from each number of years on (none listed: all of it). */
  resignation: ReadonlyArray<{ fromYears: Decimal; factor: Decimal }>;
  capMonths: Decimal | null;
}

/** Years of service from hire to a date, both included, as days / 365. */
export function yearsOfService(hireDate: string, asOf: string): Decimal {
  if (asOf < hireDate) return ZERO;
  return new Decimal(dayCount(hireDate, asOf)).dividedBy(365);
}

/** Months of base pay earned after so many years, before any resignation share. */
export function entitlementMonths(years: Decimal, rule: EosRuleInput): Decimal {
  const tiers = [...rule.tiers].sort((a, b) => a.fromYears.comparedTo(b.fromYears));
  let months = ZERO;
  tiers.forEach((t, k) => {
    const end = tiers[k + 1]?.fromYears ?? null;
    if (years.lte(t.fromYears)) return;
    const upper = end && years.gt(end) ? end : years;
    months = months.plus(upper.minus(t.fromYears).times(t.monthsPerYear));
  });
  return rule.capMonths && months.gt(rule.capMonths) ? rule.capMonths : months;
}

export function resignationFactor(years: Decimal, rule: EosRuleInput): Decimal {
  if (rule.resignation.length === 0) return new Decimal(1);
  const steps = [...rule.resignation].sort((a, b) => a.fromYears.comparedTo(b.fromYears));
  let factor = ZERO;
  for (const s of steps) if (years.gte(s.fromYears)) factor = s.factor;
  return factor;
}

export function endOfService(input: {
  currency: string;
  hireDate: string;
  asOf: string;
  monthlyBase: Decimal;
  rule: EosRuleInput;
  resigned: boolean;
}): { years: Decimal; months: Decimal; factor: Decimal; amount: Decimal } {
  const years = yearsOfService(input.hireDate, input.asOf);
  const months = entitlementMonths(years, input.rule);
  const factor = input.resigned ? resignationFactor(years, input.rule) : new Decimal(1);
  return {
    years,
    months,
    factor,
    amount: roundToCurrency(input.monthlyBase.times(months).times(factor), input.currency),
  };
}

// ─── One employee's month ───

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
  incomeTax: Decimal;
  tax: {
    tableId: string;
    code: string;
    annualTaxable: Decimal;
    annualTax: Decimal;
    band: number;
  } | null;
  otherDeductions: Decimal;
  totalDeductions: Decimal;
  net: Decimal;
  /** What the month costs the employer: pay after unpaid leave plus employer contributions. */
  employerCost: Decimal;
}

/**
 * One employee's month. Each salary segment's fixed pay is prorated by its
 * paid days; unpaid leave comes off at that segment's daily rate;
 * contributions are on the contribution base (basic and the items marked
 * for it) for the days actually worked, held within the rule's limits.
 * Income tax, when a table applies, is on gross less unpaid leave (less
 * employee contributions where the table says so), leaving out an
 * end-of-service payment. Every amount is rounded to the currency's
 * smallest unit.
 */
export function computeLine(input: {
  currency: string;
  basisDays: number;
  segments: readonly SalarySegment[];
  rules: readonly ContributionRuleInput[];
  taxTable?: TaxTableInput | null;
  adjustments: readonly AdjustmentInput[];
}): PayrollLineResult {
  const round = (v: Decimal) => roundToCurrency(v, input.currency);
  const byCode = new Map<string, { code: string; name: string; amount: Decimal }>();
  let unpaidLeaveDeduction = ZERO;
  let unpaidTotal = ZERO;
  let contributionBase = ZERO;
  let paid = 0;
  for (const seg of input.segments) {
    paid += seg.paidDays;
    const full = input.segments.length === 1 && seg.paidDays === input.basisDays;
    const prorate = (v: Decimal) =>
      full ? round(v) : round(v.times(seg.paidDays).dividedBy(input.basisDays));
    for (const c of [
      { code: "BASIC", name: "Basic", amount: seg.salary.basic },
      ...seg.salary.items,
    ]) {
      const prev = byCode.get(c.code);
      const amount = prorate(c.amount);
      byCode.set(c.code, {
        code: c.code,
        name: c.name,
        amount: (prev?.amount ?? ZERO).plus(amount),
      });
    }
    const monthlyFixed = seg.salary.items.reduce((a, i) => a.plus(i.amount), seg.salary.basic);
    const unpaid = Decimal.min(seg.unpaidLeaveDays, seg.paidDays);
    unpaidTotal = unpaidTotal.plus(unpaid);
    unpaidLeaveDeduction = unpaidLeaveDeduction.plus(
      round(monthlyFixed.dividedBy(input.basisDays).times(unpaid)),
    );
    const contributionMonthly = seg.salary.items
      .filter((i) => i.inContributionBase)
      .reduce((a, i) => a.plus(i.amount), seg.salary.basic);
    contributionBase = contributionBase.plus(
      contributionMonthly.times(new Decimal(seg.paidDays).minus(unpaid)).dividedBy(input.basisDays),
    );
  }
  const components = [...byCode.values()];
  const fixedPay = components.reduce((a, c) => a.plus(c.amount), ZERO);
  unpaidLeaveDeduction = Decimal.min(unpaidLeaveDeduction, fixedPay);

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
  const sumOf = (kind: AdjustmentInput["kind"], only?: (a: AdjustmentInput) => boolean) =>
    input.adjustments
      .filter((a) => a.kind === kind && (!only || only(a)))
      .reduce((s, a) => s.plus(round(a.amount)), ZERO);
  const additions = sumOf("ADDITION");
  const otherDeductions = sumOf("DEDUCTION");
  const gross = fixedPay.plus(additions);

  let incomeTax = ZERO;
  let tax: PayrollLineResult["tax"] = null;
  if (input.taxTable) {
    const eos = sumOf("ADDITION", (a) => a.category === "END_OF_SERVICE");
    const taxable = gross
      .minus(eos)
      .minus(unpaidLeaveDeduction)
      .minus(input.taxTable.deductContributions ? employeeContributions : ZERO);
    const r = monthlyIncomeTax(Decimal.max(taxable, 0), input.taxTable);
    incomeTax = round(r.monthly);
    tax = {
      tableId: input.taxTable.id,
      code: input.taxTable.code,
      annualTaxable: r.annualTaxable,
      annualTax: r.annualTax,
      band: r.band,
    };
  }
  const totalDeductions = unpaidLeaveDeduction
    .plus(employeeContributions)
    .plus(incomeTax)
    .plus(otherDeductions);
  return {
    basisDays: input.basisDays,
    paidDays: paid,
    unpaidLeaveDays: unpaidTotal,
    components,
    fixedPay,
    additions,
    gross,
    unpaidLeaveDeduction,
    contributions,
    employeeContributions,
    employerContributions,
    incomeTax,
    tax,
    otherDeductions,
    totalDeductions,
    net: gross.minus(totalDeductions),
    employerCost: gross.minus(unpaidLeaveDeduction).plus(employerContributions),
  };
}
