import { Decimal, type DecimalInput } from "@/lib/decimal";

/**
 * Operating expense rules (DECISIONS.md ADR-109). Pure.
 */

export const EXPENSE_GROUPS = [
  "OCCUPANCY",
  "UTILITIES",
  "STAFF",
  "MARKETING",
  "REPAIRS",
  "ADMINISTRATION",
  "DELIVERY",
  "OTHER",
] as const;
export type ExpenseGroup = (typeof EXPENSE_GROUPS)[number];

/** Gross = net + VAT, both as entered from the supplier's document. */
export function expenseGross(net: DecimalInput, tax: DecimalInput): Decimal {
  return new Decimal(net).plus(tax);
}

/** Net totals per P&L group, posted expenses only, in group order. */
export function totalsByGroup(
  expenses: ReadonlyArray<{
    group: ExpenseGroup;
    net: DecimalInput;
    status: "POSTED" | "REVERSED";
  }>,
): Array<{ group: ExpenseGroup; net: Decimal }> {
  return EXPENSE_GROUPS.map((group) => ({
    group,
    net: expenses
      .filter((e) => e.group === group && e.status === "POSTED")
      .reduce((a, e) => a.plus(e.net), new Decimal(0)),
  })).filter((g) => !g.net.isZero());
}
