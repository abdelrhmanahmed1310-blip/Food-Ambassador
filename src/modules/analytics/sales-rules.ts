import { Decimal, type DecimalInput } from "@/lib/decimal";

/**
 * Sales analytics rules (DECISIONS.md ADR-105). Pure.
 */

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** (current − base) / base; null when there is no base to compare with. */
export function growth(current: DecimalInput, base: DecimalInput): Decimal | null {
  const b = new Decimal(base);
  if (!b.gt(0)) return null;
  return new Decimal(current).minus(b).div(b);
}

/** Net per order; null without orders. */
export function averageTicket(net: DecimalInput, orders: number): Decimal | null {
  return orders > 0 ? new Decimal(net).div(orders) : null;
}

function minusYear(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${String(y - 1).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** The same calendar dates one year earlier (29 February becomes the 28th). */
export function samePeriodLastYear(from: string, to: string) {
  return { from: minusYear(from), to: minusYear(to) };
}

export function daysBetween(from: string, to: string): number {
  return Math.round((ms(to) - ms(from)) / DAY) + 1;
}

/**
 * A monthly target spread evenly over the month's days: the target for
 * [from, to] is each month's amount × days of the period in that month ÷
 * days in the month. Months without a target count as no target; when no
 * month in the period has one, the result is null.
 */
export function proratedTarget(
  targets: ReadonlyArray<{ month: string; amount: DecimalInput }>,
  from: string,
  to: string,
): Decimal | null {
  let total = new Decimal(0);
  let any = false;
  for (const t of targets) {
    const start = t.month.slice(0, 7) + "-01";
    const [y, m] = start.split("-").map(Number);
    const end = iso(Date.UTC(y, m, 0));
    const a = Math.max(ms(start), ms(from));
    const b = Math.min(ms(end), ms(to));
    if (a > b) continue;
    any = true;
    const overlap = Math.round((b - a) / DAY) + 1;
    total = total.plus(new Decimal(t.amount).times(overlap).div(daysBetween(start, end)));
  }
  return any ? total : null;
}

/** ISO weekday 1 (Monday) … 7 (Sunday) of a calendar date. */
export function isoWeekday(d: string): number {
  const w = new Date(ms(d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** First day of each month from `from`'s month to `to`'s, as YYYY-MM-01. */
export function monthsCovering(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
