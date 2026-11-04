import "server-only";
import { z } from "zod";
import { toCsv } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { Decimal } from "@/lib/decimal";
import { hasPermission } from "@/modules/access/authorize";
import { currencyConverter } from "@/modules/fx/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { forbidden, validationFailed } from "@/server/errors";
import { branchActualsInTx } from "./actuals";
import { eliminations, PNL_ROWS, pnlColumn, sumFigures, type PnlFigures } from "./pnl-rules";

/**
 * Consolidated group P&L (DECISIONS.md ADR-112). Each company's P&L from
 * the shared branch actuals (ADR-110, ADR-111) in its own currency, then
 * converted into the group currency at the period's average rate (ADR-086;
 * the latest earlier rate when the period has none). Sales to the group's
 * own companies are eliminated against cost of sales. A company whose
 * currency has no usable rate is left out of the group total and named.
 * Needs `pnl.consolidated.view` for the whole organization.
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

export const canSeeConsolidation = (ctx: TenantContext) =>
  hasPermission(ctx.grants, "pnl.consolidated.view");

const KEYS = [
  "SALES_POS",
  "SALES_IMPORTED",
  "SALES_B2B",
  "INTERCOMPANY_SALES",
  "SALES",
  "COST_OF_SALES",
  "STOCK_LOSSES",
  "OCCUPANCY",
  "UTILITIES",
  "STAFF",
  "MARKETING",
  "REPAIRS",
  "ADMINISTRATION",
  "DELIVERY",
  "OTHER",
] as const satisfies ReadonlyArray<keyof PnlFigures>;

export async function consolidatedPnl(ctx: TenantContext, rawPeriod: unknown) {
  if (!canSeeConsolidation(ctx)) throw forbidden();
  const p = periodSchema.safeParse(rawPeriod);
  if (!p.success) throw validationFailed(p.error);
  const period = p.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branches = await tx.branch.findMany({
      where: { organizationId: ctx.organizationId },
      select: {
        id: true,
        company: {
          select: { id: true, code: true, name: true, currency: true, archivedAt: true },
        },
      },
    });
    const actuals = await branchActualsInTx(
      tx,
      ctx,
      branches.map((b) => b.id),
      period.from,
      period.to,
    );
    const conv = await currencyConverter(tx, ctx, {
      to: ctx.groupCurrency,
      date: period.to,
      from: period.from,
    });
    const companies = [...new Map(branches.map((b) => [b.company.id, b.company])).values()].sort(
      (a, b) => a.code.localeCompare(b.code),
    );
    const results = [];
    for (const c of companies) {
      const local = sumFigures(
        branches
          .filter((b) => b.company.id === c.id)
          .flatMap((b) => [...(actuals.get(b.id)?.values() ?? [])]),
      );
      const active = KEYS.some((k) => local[k] && !local[k]!.isZero());
      // Archived companies only when something happened in the period.
      if (c.archivedAt && !active) continue;
      let converted: PnlFigures | null = {};
      for (const k of KEYS) {
        if (local[k] === undefined) continue;
        const v = await conv.convert(local[k]!, c.currency);
        if (v === null) {
          converted = null;
          break;
        }
        converted[k] = v;
      }
      results.push({ company: c, local, localColumn: pnlColumn(local), converted });
    }
    const included = results.filter((r) => r.converted !== null);
    const intercompany = included.reduce(
      (a, r) => a.plus(r.converted!.INTERCOMPANY_SALES ?? 0),
      new Decimal(0),
    );
    const elim = eliminations(intercompany);
    return {
      period,
      currency: conv.currency,
      rows: PNL_ROWS,
      missingRates: conv.missing(),
      companies: results.map((r) => ({
        company: {
          id: r.company.id,
          code: r.company.code,
          name: r.company.name,
          currency: r.company.currency,
        },
        local: r.localColumn,
        intercompanySales: r.local.INTERCOMPANY_SALES ?? new Decimal(0),
        converted: r.converted === null ? null : pnlColumn(r.converted),
      })),
      intercompanySales: intercompany,
      eliminations: pnlColumn(elim),
      group: pnlColumn(sumFigures([...included.map((r) => r.converted!), elim])),
    };
  });
}

export async function exportConsolidatedCsv(ctx: TenantContext, rawPeriod: unknown) {
  const r = await consolidatedPnl(ctx, rawPeriod);
  const shown = r.companies.filter((c) => c.converted !== null);
  return toCsv(
    [
      "line",
      ...shown.map((c) => `${c.company.code} (${r.currency})`),
      `eliminations (${r.currency})`,
      `group (${r.currency})`,
      "group % of sales",
    ],
    r.rows.map((row) => [
      row,
      ...shown.map((c) => c.converted!.values[row].toFixed(2)),
      r.eliminations.values[row].toFixed(2),
      r.group.values[row].toFixed(2),
      r.group.shares[row] === null ? "" : r.group.shares[row]!.times(100).toFixed(1),
    ]),
  );
}
