import { Decimal } from "@/lib/decimal";
import { shareOfSales, withDerived, type Figures } from "./budget-rules";
import { EXPENSE_GROUPS } from "./expense-rules";

/**
 * Branch P&L (DECISIONS.md ADR-111). Pure.
 */

/** Net sales by where they came from: the till, sales imports, B2B invoices. */
export const SALES_SOURCES = ["SALES_POS", "SALES_IMPORTED", "SALES_B2B"] as const;
export type SalesSource = (typeof SALES_SOURCES)[number];
/**
 * INTERCOMPANY_SALES: the part of SALES_B2B invoiced to the group's own
 * companies (ADR-112) — eliminated on consolidation, not a P&L row.
 */
export type PnlFigures = Figures & Partial<Record<SalesSource | "INTERCOMPANY_SALES", Decimal>>;

/** Rows of the P&L, in order; sales by source first. */
export const PNL_ROWS = [
  ...SALES_SOURCES,
  "SALES",
  "COST_OF_SALES",
  "GROSS_PROFIT",
  "STOCK_LOSSES",
  ...EXPENSE_GROUPS,
  "TOTAL_EXPENSES",
  "OPERATING_RESULT",
] as const;
export type PnlRow = (typeof PNL_ROWS)[number];

const KEYS = [
  ...SALES_SOURCES,
  "INTERCOMPANY_SALES",
  "SALES",
  "COST_OF_SALES",
  "STOCK_LOSSES",
  ...EXPENSE_GROUPS,
] as const;

/** Adds several figure sets (months, branches of one currency). */
export function sumFigures(list: ReadonlyArray<PnlFigures>): PnlFigures {
  const out: PnlFigures = {};
  for (const f of list)
    for (const k of KEYS) if (f[k] !== undefined) out[k] = (out[k] ?? new Decimal(0)).plus(f[k]!);
  return out;
}

/**
 * One P&L column: every row (a figure that did not occur is zero) and each
 * row as a share of net sales — nothing when there were no sales.
 */
export function pnlColumn(f: PnlFigures) {
  const filled: PnlFigures = {};
  for (const k of KEYS) filled[k] = f[k] ?? new Decimal(0);
  const derived = withDerived(filled);
  const values = {} as Record<PnlRow, Decimal>;
  const shares = {} as Record<PnlRow, Decimal | null>;
  for (const row of PNL_ROWS) {
    const v = (SALES_SOURCES as readonly string[]).includes(row)
      ? filled[row as SalesSource]!
      : derived[row as keyof typeof derived]!;
    values[row] = v;
    shares[row] = shareOfSales(v, filled.SALES!);
  }
  return { values, shares };
}

/**
 * Consolidation eliminations (ADR-112): sales invoiced to the group's own
 * companies come off net sales (B2B) and, by the same amount, off cost of
 * sales — the buying company's cost of that stock. Profit still held in the
 * buyer's unsold stock is not eliminated.
 */
export function eliminations(intercompanySales: Decimal): PnlFigures {
  const minus = intercompanySales.negated();
  return { SALES_B2B: minus, SALES: minus, COST_OF_SALES: minus };
}
