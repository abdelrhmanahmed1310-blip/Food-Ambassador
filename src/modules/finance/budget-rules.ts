import { Decimal, type DecimalInput } from "@/lib/decimal";
import { EXPENSE_GROUPS, type ExpenseGroup } from "./expense-rules";

/**
 * Budget against actual (DECISIONS.md ADR-110). Pure.
 */

/** Rows of a branch budget, in P&L order; the derived ones are computed. */
export const BUDGET_ROWS = [
  "SALES",
  "COST_OF_SALES",
  "GROSS_PROFIT",
  "STOCK_LOSSES",
  ...EXPENSE_GROUPS,
  "TOTAL_EXPENSES",
  "OPERATING_RESULT",
] as const;
export type BudgetRow = (typeof BUDGET_ROWS)[number];
export const DERIVED_ROWS: readonly BudgetRow[] = [
  "GROSS_PROFIT",
  "TOTAL_EXPENSES",
  "OPERATING_RESULT",
];
/** Rows where more than budget is good. */
const INCOME_ROWS: readonly BudgetRow[] = ["SALES", "GROSS_PROFIT", "OPERATING_RESULT"];

/**
 * Entered or actual figures. STOCK_LOSSES (waste, adjustments and count
 * differences, ADR-111) is actual only: it has no budget line.
 */
export type Figures = Partial<
  Record<"SALES" | "COST_OF_SALES" | "STOCK_LOSSES" | ExpenseGroup, Decimal>
>;

/**
 * Every row from the entered lines: gross profit = sales − cost of sales;
 * total expenses; operating result = gross profit − stock losses − total
 * expenses.
 */
export function withDerived(f: Figures): Record<BudgetRow, Decimal | null> {
  const has = (k: keyof Figures) => f[k] !== undefined;
  const v = (k: keyof Figures) => f[k] ?? new Decimal(0);
  const anyExpense = EXPENSE_GROUPS.some((g) => has(g));
  const totalExpenses = anyExpense
    ? EXPENSE_GROUPS.reduce((a, g) => a.plus(v(g)), new Decimal(0))
    : null;
  const gross = has("SALES") || has("COST_OF_SALES") ? v("SALES").minus(v("COST_OF_SALES")) : null;
  const out = {} as Record<BudgetRow, Decimal | null>;
  for (const row of BUDGET_ROWS) out[row] = null;
  if (has("SALES")) out.SALES = v("SALES");
  if (has("COST_OF_SALES")) out.COST_OF_SALES = v("COST_OF_SALES");
  if (has("STOCK_LOSSES")) out.STOCK_LOSSES = v("STOCK_LOSSES");
  for (const g of EXPENSE_GROUPS) if (has(g)) out[g] = v(g);
  out.GROSS_PROFIT = gross;
  out.TOTAL_EXPENSES = totalExpenses;
  out.OPERATING_RESULT =
    gross === null && totalExpenses === null && !has("STOCK_LOSSES")
      ? null
      : (gross ?? new Decimal(0)).minus(v("STOCK_LOSSES")).minus(totalExpenses ?? new Decimal(0));
  return out;
}

/** A row as a share of sales (margins); nothing without sales. */
export function shareOfSales(value: Decimal | null, sales: Decimal | null): Decimal | null {
  if (value === null || sales === null || sales.isZero()) return null;
  return value.div(sales);
}

/**
 * Actual − budget, as a share of the budget, and whether it is favourable:
 * above budget is good for income rows, below budget is good for cost rows.
 * Nothing without a budget.
 */
export function variance(
  row: BudgetRow,
  budget: DecimalInput | null,
  actual: DecimalInput,
): { difference: Decimal; share: Decimal | null; favourable: boolean } | null {
  if (budget === null) return null;
  const b = new Decimal(budget);
  const difference = new Decimal(actual).minus(b);
  const income = INCOME_ROWS.includes(row);
  return {
    difference,
    share: b.isZero() ? null : difference.div(b.abs()),
    favourable: income ? difference.gte(0) : difference.lte(0),
  };
}
