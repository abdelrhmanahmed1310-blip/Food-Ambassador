import { Decimal, type DecimalInput } from "@/lib/decimal";

/**
 * Stock ageing, turnover and days on hand (DECISIONS.md ADR-106). Pure.
 */

/** Age buckets in days (a display convention of this product, not a standard). */
export const AGE_BUCKETS = [
  { key: "D0_30", max: 30 },
  { key: "D31_60", max: 60 },
  { key: "D61_90", max: 90 },
  { key: "D91_180", max: 180 },
  { key: "D181_PLUS", max: Infinity },
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number]["key"];

export function ageBucket(days: number): AgeBucket {
  return AGE_BUCKETS.find((b) => days <= b.max)!.key;
}

const DAY = 86_400_000;
export function ageInDays(since: string, today: string): number {
  return Math.max(
    0,
    Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY),
  );
}

/**
 * Ages of stock held without lots, first in first out: what is on hand is
 * taken to be the most recent arrivals. Arrivals are (date, quantity);
 * anything not covered by recorded arrivals is reported with age null.
 */
export function fifoAges(
  onHand: DecimalInput,
  arrivals: ReadonlyArray<{ date: string; quantity: DecimalInput }>,
  today: string,
): Array<{ ageDays: number | null; quantity: Decimal }> {
  let left = new Decimal(onHand);
  const out: Array<{ ageDays: number | null; quantity: Decimal }> = [];
  const newestFirst = [...arrivals].sort((a, b) => b.date.localeCompare(a.date));
  for (const a of newestFirst) {
    if (left.lte(0)) break;
    const q = new Decimal(a.quantity);
    if (q.lte(0)) continue;
    const take = Decimal.min(q, left);
    out.push({ ageDays: ageInDays(a.date, today), quantity: take });
    left = left.minus(take);
  }
  if (left.gt(0)) out.push({ ageDays: null, quantity: left });
  return out;
}

/** Usage value ÷ average of opening and closing value; null without stock to turn. */
export function turnover(
  usage: DecimalInput,
  opening: DecimalInput,
  closing: DecimalInput,
): Decimal | null {
  const average = new Decimal(opening).plus(closing).div(2);
  if (!average.gt(0)) return null;
  return new Decimal(usage).div(average);
}

/** Closing value ÷ average daily usage over the period; null without usage. */
export function daysOnHand(
  closing: DecimalInput,
  usage: DecimalInput,
  days: number,
): Decimal | null {
  const u = new Decimal(usage);
  if (!u.gt(0) || days <= 0) return null;
  return new Decimal(closing).div(u.div(days));
}
