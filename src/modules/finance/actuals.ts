import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import type { TenantContext } from "@/modules/tenancy/context";
import type { Tx } from "@/server/db/transactions";
import type { Figures } from "./budget-rules";
import type { ExpenseGroup } from "./expense-rules";

/**
 * Branch actuals per month (DECISIONS.md ADR-110), in each branch's company
 * currency — the one definition used by budgets and the branch P&L:
 * - SALES: paid POS orders net of VAT and refunds (business date), imported
 *   sales lines' net amounts (sale date; reversed imports excluded) and
 *   posted B2B sales invoices' net in the company currency (invoice date).
 * - COST_OF_SALES: the stock value POS orders used, the stock value of
 *   imported sales (shared over the import's months by net amount, or by
 *   line count when it has none) and the cost of goods of B2B invoices.
 * - Expense groups: posted operating expenses' net (expense date).
 * Months are "YYYY-MM". Callers check permissions.
 */

const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? "0");

export type MonthFigures = Map<string, Figures>;

export async function branchActualsInTx(
  tx: Tx,
  ctx: TenantContext,
  branchIds: string[],
  from: string,
  to: string,
): Promise<Map<string, MonthFigures>> {
  const out = new Map<string, MonthFigures>(branchIds.map((b) => [b, new Map()]));
  if (branchIds.length === 0) return out;
  const org = ctx.organizationId;
  const add = (branchId: string, month: string, key: keyof Figures, v: Decimal) => {
    if (v.isZero()) return;
    const months = out.get(branchId);
    if (!months) return;
    const f = months.get(month) ?? {};
    f[key] = (f[key] ?? new Decimal(0)).plus(v);
    months.set(month, f);
  };
  type Row = {
    branch_id: string;
    m: string;
    net: Prisma.Decimal | null;
    cost: Prisma.Decimal | null;
  };
  const [pos, imports, b2b, expenses] = await Promise.all([
    tx.$queryRaw<Row[]>`
      SELECT o.branch_id, to_char(o.business_date, 'YYYY-MM') AS m,
             SUM(o.net_amount - coalesce(r.net, 0)) AS net, SUM(o.cost_amount) AS cost
      FROM pos_orders o
      LEFT JOIN (
        SELECT order_id, SUM(amount - tax_amount) AS net FROM pos_refunds
        WHERE organization_id = ${org}::uuid GROUP BY order_id
      ) r ON r.order_id = o.id
      WHERE o.organization_id = ${org}::uuid AND o.status = 'PAID'
        AND o.branch_id = ANY(${branchIds}::uuid[])
        AND o.business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1, 2`,
    tx.$queryRaw<Row[]>`
      WITH per AS (
        SELECT i.id AS import_id, w.branch_id, to_char(l.sold_on, 'YYYY-MM') AS m,
               SUM(coalesce(l.net_amount, 0)) AS net, COUNT(*) AS n, i.cost_amount
        FROM sales_lines l
        JOIN sales_imports i ON i.id = l.import_id
        JOIN warehouses w ON w.id = i.warehouse_id
        WHERE l.organization_id = ${org}::uuid AND l.active AND i.status = 'POSTED'
          AND w.branch_id = ANY(${branchIds}::uuid[])
        GROUP BY i.id, w.branch_id, 3, i.cost_amount
      ), tot AS (
        SELECT import_id, SUM(net) AS tnet, SUM(n) AS tn FROM per GROUP BY import_id
      )
      SELECT per.branch_id, per.m, SUM(per.net) AS net,
             SUM(CASE WHEN tot.tnet > 0 THEN per.cost_amount * per.net / tot.tnet
                      ELSE per.cost_amount * per.n / tot.tn END) AS cost
      FROM per JOIN tot ON tot.import_id = per.import_id
      WHERE per.m BETWEEN ${from.slice(0, 7)} AND ${to.slice(0, 7)}
      GROUP BY 1, 2`,
    tx.$queryRaw<Row[]>`
      SELECT w.branch_id, to_char(si.invoice_date, 'YYYY-MM') AS m,
             SUM(si.net_amount_base) AS net, SUM(si.cost) AS cost
      FROM sales_invoices si
      JOIN customer_deliveries d ON d.id = si.delivery_id
      JOIN sales_orders so ON so.id = d.order_id
      JOIN warehouses w ON w.id = so.warehouse_id
      WHERE si.organization_id = ${org}::uuid AND si.status = 'POSTED'
        AND w.branch_id = ANY(${branchIds}::uuid[])
        AND si.invoice_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1, 2`,
    tx.$queryRaw<Array<{ branch_id: string; m: string; grp: ExpenseGroup; net: Prisma.Decimal }>>`
      SELECT e.branch_id, to_char(e.expense_date, 'YYYY-MM') AS m, c."group"::text AS grp,
             SUM(e.net_amount) AS net
      FROM expenses e
      JOIN expense_categories c ON c.id = e.category_id
      WHERE e.organization_id = ${org}::uuid AND e.status = 'POSTED'
        AND e.branch_id = ANY(${branchIds}::uuid[])
        AND e.expense_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1, 2, 3`,
  ]);
  for (const r of [...pos, ...imports, ...b2b]) {
    add(r.branch_id, r.m, "SALES", dec(r.net));
    add(r.branch_id, r.m, "COST_OF_SALES", dec(r.cost));
  }
  for (const r of expenses) add(r.branch_id, r.m, r.grp, dec(r.net));
  return out;
}
