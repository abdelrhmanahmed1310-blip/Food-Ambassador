import { Decimal } from "@/lib/decimal";

/** Menu rules (DECISIONS.md ADR-058). Pure. */

export const SALES_CHANNELS = ["DINE_IN", "TAKEAWAY", "DELIVERY"] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export interface PriceRow {
  channel: SalesChannel;
  branchId: string | null;
  price: Decimal;
  includesTax: boolean;
  effectiveFrom: string;
}

/**
 * The price of an item on a channel at a branch on a date: the branch's own
 * price if it has one in effect, else the price for all branches; the latest
 * one starting on or before the date. Null = not sold on that channel.
 */
export function resolvePrice(
  rows: readonly PriceRow[],
  at: { channel: SalesChannel; branchId: string; date: string },
): PriceRow | null {
  const latest = (branchId: string | null) =>
    rows
      .filter(
        (r) => r.channel === at.channel && r.branchId === branchId && r.effectiveFrom <= at.date,
      )
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
  return latest(at.branchId) ?? latest(null);
}

export interface GroupRule {
  groupId: string;
  minSelect: number;
  maxSelect: number;
  optionIds: readonly string[];
}

export type SelectionProblem =
  | { problem: "UNKNOWN_OPTION"; optionId: string }
  | { problem: "TOO_FEW"; groupId: string; min: number }
  | { problem: "TOO_MANY"; groupId: string; max: number };

/** Whether a set of chosen options satisfies the item's modifier groups (each option once). */
export function checkSelection(
  groups: readonly GroupRule[],
  chosen: readonly string[],
): SelectionProblem[] {
  const problems: SelectionProblem[] = [];
  const known = new Set(groups.flatMap((g) => g.optionIds));
  for (const id of new Set(chosen))
    if (!known.has(id)) problems.push({ problem: "UNKNOWN_OPTION", optionId: id });
  for (const g of groups) {
    const n = new Set(chosen.filter((id) => g.optionIds.includes(id))).size;
    if (n < g.minSelect)
      problems.push({ problem: "TOO_FEW", groupId: g.groupId, min: g.minSelect });
    if (n > g.maxSelect)
      problems.push({ problem: "TOO_MANY", groupId: g.groupId, max: g.maxSelect });
  }
  return problems;
}

/** Unit price with the chosen options' price changes; never below zero. */
export function unitPrice(itemPrice: Decimal, deltas: readonly Decimal[]): Decimal {
  return Decimal.max(
    deltas.reduce((a, d) => a.plus(d), itemPrice),
    0,
  );
}
