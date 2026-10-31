import { Decimal } from "@/lib/decimal";

/**
 * Pure report rules (DECISIONS.md ADR-042). Ratios are only shown when both
 * sides are known; nothing is estimated.
 */

/** cost ÷ net sales, or null when net sales are unknown or zero. */
export function ratio(cost: Decimal, net: Decimal | null): Decimal | null {
  if (net === null || net.isZero()) return null;
  return cost.dividedBy(net);
}

export interface ImportSpan {
  id: string;
  firstSale: string;
  lastSale: string;
}

/**
 * Sales imports carry one cost of sales for the whole file, so an import
 * counts in a period only when all its sales dates fall inside it; files
 * that straddle the boundary are listed, not split.
 */
export function splitByPeriod<T extends ImportSpan>(
  imports: readonly T[],
  from: string,
  to: string,
) {
  const inside: T[] = [];
  const straddling: T[] = [];
  for (const i of imports) {
    if (i.lastSale < from || i.firstSale > to) continue;
    if (i.firstSale >= from && i.lastSale <= to) inside.push(i);
    else straddling.push(i);
  }
  return { inside, straddling };
}

/** YYYY-MM of a date, or null when the span crosses months. */
export function monthOf(span: ImportSpan): string | null {
  const m = span.firstSale.slice(0, 7);
  return span.lastSale.slice(0, 7) === m ? m : null;
}

/** The last `count` months ending with the month of `today`, oldest first. */
export function lastMonths(today: string, count: number): string[] {
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}
