import "server-only";
import { z } from "zod";
import { toCsv } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { accessibleScope, holdsAnyGrant } from "@/modules/access/authorize";
import { samePeriodLastYear } from "@/modules/analytics/sales-rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { forbidden, validationFailed } from "@/server/errors";
import { branchActualsInTx } from "./actuals";
import { PNL_ROWS, pnlColumn, sumFigures, type PnlFigures } from "./pnl-rules";

/**
 * Branch P&L (DECISIONS.md ADR-111) from the shared branch actuals
 * (ADR-110): net sales by source, cost of sales, gross profit, stock
 * losses, operating expenses by group and the operating result, each as a
 * share of sales. Branches are in their company's currency; totals are per
 * company (consolidation across currencies is C5d). With one branch the
 * columns are its months, the period's total and the same period last
 * year. Needs `pnl.view` at the branches shown.
 */

const periodSchema = z
  .object({
    from: z.string().refine(isCalendarDate, { error: "invalidDate" }),
    to: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  })
  .refine((p) => p.from <= p.to, { error: "invalidPeriod", path: ["to"] })
  .refine((p) => Number(p.to.slice(0, 4)) - Number(p.from.slice(0, 4)) <= 2, {
    error: "invalidPeriod",
    path: ["to"],
  });

export const canSeePnl = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "pnl.view");

export type PnlColumn = {
  key: string;
  kind: "BRANCH" | "COMPANY" | "MONTH" | "TOTAL" | "LAST_YEAR";
  label: string;
  currency: string;
} & ReturnType<typeof pnlColumn>;

export async function branchPnl(
  ctx: TenantContext,
  rawPeriod: unknown,
  filters: { companyId?: string; branchId?: string } = {},
) {
  if (!canSeePnl(ctx)) throw forbidden();
  const p = periodSchema.safeParse(rawPeriod);
  if (!p.success) throw validationFailed(p.error);
  const period = p.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const scope = accessibleScope(ctx.grants, "pnl.view");
    const all = await tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(filters.companyId ? { companyId: filters.companyId } : {}),
        ...(scope.all
          ? {}
          : {
              OR: [
                { id: { in: scope.branchIds } },
                { warehouses: { some: { id: { in: scope.warehouseIds } } } },
              ],
            }),
      },
      select: {
        id: true,
        code: true,
        name: true,
        archivedAt: true,
        company: { select: { id: true, code: true, name: true, currency: true } },
      },
      orderBy: { code: "asc" },
    });
    const branches = filters.branchId ? all.filter((b) => b.id === filters.branchId) : all;
    const actuals = await branchActualsInTx(
      tx,
      ctx,
      branches.map((b) => b.id),
      period.from,
      period.to,
    );
    const total = (branchId: string) => sumFigures([...(actuals.get(branchId)?.values() ?? [])]);
    const column = (
      key: string,
      kind: PnlColumn["kind"],
      label: string,
      currency: string,
      f: PnlFigures,
    ): PnlColumn => ({ key, kind, label, currency, ...pnlColumn(f) });

    let columns: PnlColumn[];
    if (filters.branchId && branches.length === 1) {
      const b = branches[0];
      const months = actuals.get(b.id)!;
      const keys: string[] = [];
      for (let m = period.from.slice(0, 7); m <= period.to.slice(0, 7);) {
        keys.push(m);
        const [y, mm] = m.split("-").map(Number);
        m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
      }
      const ly = samePeriodLastYear(period.from, period.to);
      const last = await branchActualsInTx(tx, ctx, [b.id], ly.from, ly.to);
      columns = [
        ...(keys.length > 1
          ? keys.map((m) => column(m, "MONTH", m, b.company.currency, months.get(m) ?? {}))
          : []),
        column("total", "TOTAL", `${period.from}|${period.to}`, b.company.currency, total(b.id)),
        column(
          "lastYear",
          "LAST_YEAR",
          `${ly.from}|${ly.to}`,
          b.company.currency,
          sumFigures([...(last.get(b.id)?.values() ?? [])]),
        ),
      ];
    } else {
      // Archived branches only when something happened there in the period.
      const shown = branches.filter((b) => !b.archivedAt || (actuals.get(b.id)?.size ?? 0) > 0);
      columns = shown.map((b) =>
        column(b.id, "BRANCH", `${b.code} — ${b.name}`, b.company.currency, total(b.id)),
      );
      const companies = [...new Map(shown.map((b) => [b.company.id, b.company])).values()];
      for (const c of companies) {
        const of = shown.filter((b) => b.company.id === c.id);
        if (of.length < 2) continue;
        columns.push(
          column(
            `company:${c.id}`,
            "COMPANY",
            `${c.code} — ${c.name}`,
            c.currency,
            sumFigures(of.map((b) => total(b.id))),
          ),
        );
      }
    }
    return {
      period,
      rows: PNL_ROWS,
      columns,
      branches: all.map((b) => ({ id: b.id, code: b.code, name: b.name })),
    };
  });
}

export async function exportPnlCsv(
  ctx: TenantContext,
  rawPeriod: unknown,
  filters: { companyId?: string; branchId?: string } = {},
) {
  const r = await branchPnl(ctx, rawPeriod, filters);
  return toCsv(
    ["line", ...r.columns.flatMap((c) => [`${c.label} (${c.currency})`, `${c.label} % of sales`])],
    r.rows.map((row) => [
      row,
      ...r.columns.flatMap((c) => [
        c.values[row].toFixed(2),
        c.shares[row] === null ? "" : c.shares[row]!.times(100).toFixed(1),
      ]),
    ]),
  );
}
