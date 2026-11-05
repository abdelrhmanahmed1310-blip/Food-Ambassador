/**
 * HR analytics rules (DECISIONS.md ADR-130). Pure; ratios are plain
 * numbers rounded for display (no money here — pay totals stay Decimal).
 */

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);

export interface Person {
  hireDate: string;
  /** Last day employed, when they left. */
  terminatedOn: string | null;
}

/** Employed on a day: hired by then and not yet past their last day. */
export const employedOn = (p: Person, day: string) =>
  p.hireDate <= day && (p.terminatedOn === null || p.terminatedOn >= day);

export const headcountOn = (people: readonly Person[], day: string) =>
  people.filter((p) => employedOn(p, day)).length;

/** One decimal place, as a percentage of a ratio; null when there is no base. */
export const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

export function monthBounds(month: string) {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = iso(Date.UTC(y, m, 0));
  return { start, end };
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
    if (out.length > 36) break;
  }
  return out;
}

export interface MonthRow {
  month: string;
  start: number;
  end: number;
  hires: number;
  leavers: number;
  /** Leavers ÷ average of start and end headcount, in %. */
  turnover: number | null;
}

/**
 * Headcount at the start and end of each month, hires and leavers in it,
 * and turnover against the average headcount.
 */
export function monthlySeries(people: readonly Person[], months: readonly string[]): MonthRow[] {
  return months.map((month) => {
    const { start, end } = monthBounds(month);
    const s = headcountOn(people, start);
    const e = headcountOn(people, end);
    const hires = people.filter((p) => p.hireDate >= start && p.hireDate <= end).length;
    const leavers = people.filter(
      (p) => p.terminatedOn !== null && p.terminatedOn >= start && p.terminatedOn <= end,
    ).length;
    return { month, start: s, end: e, hires, leavers, turnover: pct(leavers, (s + e) / 2) };
  });
}

/** Totals over a range: turnover is leavers ÷ the average of the monthly averages. */
export function rangeSummary(rows: readonly MonthRow[]) {
  const hires = rows.reduce((a, r) => a + r.hires, 0);
  const leavers = rows.reduce((a, r) => a + r.leavers, 0);
  const avg = rows.length ? rows.reduce((a, r) => a + (r.start + r.end) / 2, 0) / rows.length : 0;
  return {
    start: rows[0]?.start ?? 0,
    end: rows.at(-1)?.end ?? 0,
    hires,
    leavers,
    averageHeadcount: Math.round(avg * 10) / 10,
    turnover: pct(leavers, avg),
  };
}

export const TENURE_BANDS = ["UNDER_3M", "3_TO_12M", "1_TO_3Y", "OVER_3Y"] as const;
export type TenureBand = (typeof TENURE_BANDS)[number];

/** Tenure on a day of those employed then. */
export function tenureBands(people: readonly Person[], day: string): Record<TenureBand, number> {
  const out = { UNDER_3M: 0, "3_TO_12M": 0, "1_TO_3Y": 0, OVER_3Y: 0 } as Record<
    TenureBand,
    number
  >;
  for (const p of people) {
    if (!employedOn(p, day)) continue;
    const d = daysBetween(p.hireDate, day);
    out[d < 91 ? "UNDER_3M" : d < 365 ? "3_TO_12M" : d < 1095 ? "1_TO_3Y" : "OVER_3Y"]++;
  }
  return out;
}

/**
 * New-hire retention: of those hired in the range who are at least 90 days
 * past their hire date by `today`, the share still employed on day 90.
 */
export function newHireRetention(
  people: readonly Person[],
  from: string,
  to: string,
  today: string,
) {
  const cohort = people.filter(
    (p) => p.hireDate >= from && p.hireDate <= to && addDays(p.hireDate, 90) <= today,
  );
  const kept = cohort.filter((p) => employedOn(p, addDays(p.hireDate, 90))).length;
  return { cohort: cohort.length, kept, rate: pct(kept, cohort.length) };
}

/** Average and median of a list of day counts. */
export function daysStats(values: readonly number[]) {
  if (values.length === 0) return { count: 0, average: null, median: null };
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    count: s.length,
    average: Math.round((s.reduce((a, v) => a + v, 0) / s.length) * 10) / 10,
    median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
  };
}

/** Calendar days of a span that fall inside a range (both ends included). */
export function overlapDays(a0: string, a1: string, b0: string, b1: string): number {
  const s = a0 > b0 ? a0 : b0;
  const e = a1 < b1 ? a1 : b1;
  return s > e ? 0 : daysBetween(s, e) + 1;
}

/** Absence rate: leave days ÷ (average headcount × calendar days of the range), in %. */
export const absenceRate = (leaveDays: number, averageHeadcount: number, rangeDays: number) =>
  pct(leaveDays, averageHeadcount * rangeDays);
