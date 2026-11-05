import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { Decimal } from "@/lib/decimal";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { canOnWarehouse } from "@/modules/procurement/orders";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { notFound } from "@/server/errors";
import { forecast, HISTORY_DAYS, weeklyTotals, type ForecastResult } from "./rules";

/**
 * Demand history and forecasts per product × warehouse (DECISIONS.md
 * ADR-120). Demand is what left the warehouse to be used: consumption
 * (sales and production), customer deliveries and transfers to another
 * warehouse, net of their reversals, by business day in the warehouse's
 * time zone. Moves between locations of one warehouse, write-offs, returns
 * and count differences are not demand. Nothing is stored: forecasts are
 * worked out from the ledger each time and say how they were made.
 */

const ZERO = new Decimal(0);
const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? "0");
const ms = (date: string) => Date.parse(`${date}T00:00:00Z`);

export interface DemandHistory {
  /** Daily demand, base units, HISTORY_DAYS days ending yesterday. */
  series: Decimal[];
  /** Days from the product's first movement at the warehouse to yesterday. */
  historyDays: number;
}

export interface ForecastWarehouse {
  id: string;
  timeZone: string | null;
}

/**
 * What counts as demand: OUTBOUND is everything that left the warehouse to
 * be used (use, customer deliveries, transfers to another warehouse); USE
 * is use and customer deliveries only, for demand summed over all
 * warehouses, where transfers between them are not demand (ADR-121).
 */
export type DemandKind = "OUTBOUND" | "USE";

/**
 * Daily demand for the given products (or every product that moved at the
 * warehouse in the window) over the HISTORY_DAYS days before `today`. With
 * `allWarehouses`, demand of the whole organization, by business day in the
 * given warehouse's time zone.
 */
export async function demandHistoryInTx(
  tx: Tx,
  ctx: TenantContext,
  warehouse: ForecastWarehouse,
  today: string,
  productIds?: string[],
  options: { kind?: DemandKind; allWarehouses?: boolean } = {},
): Promise<Map<string, DemandHistory>> {
  const tz = warehouse.timeZone ?? ctx.timeZone;
  const kind = options.kind ?? "OUTBOUND";
  const where = options.allWarehouses
    ? Prisma.empty
    : Prisma.sql`AND e.warehouse_id = ${warehouse.id}::uuid`;
  const transfers =
    kind === "OUTBOUND"
      ? Prisma.sql`OR (x.kind = 'TRANSFER_OUT' AND NOT EXISTS (
            SELECT 1 FROM inventory_ledger_entries i
            WHERE i.organization_id = e.organization_id AND i.document_id = x.doc
              AND i.movement_type = 'TRANSFER_IN' AND i.warehouse_id = e.warehouse_id
              AND i.product_id = e.product_id))`
      : Prisma.empty;
  const from = addDays(today, -HISTORY_DAYS);
  const to = addDays(today, -1);
  if (productIds && productIds.length === 0) return new Map();
  const only = productIds
    ? Prisma.sql`AND e.product_id = ANY(${productIds}::uuid[])`
    : Prisma.empty;
  const [daily, first] = await inSequence([
    tx.$queryRaw<Array<{ product_id: string; d: Date; quantity: Prisma.Decimal }>>`
      SELECT e.product_id, x.d, -SUM(e.quantity_delta) AS quantity
      FROM inventory_ledger_entries e
      LEFT JOIN inventory_ledger_entries o
        ON o.organization_id = e.organization_id AND o.id = e.reverses_entry_id
      CROSS JOIN LATERAL (
        SELECT (e.occurred_at AT TIME ZONE ${tz})::date AS d,
               coalesce(o.movement_type, e.movement_type) AS kind,
               coalesce(o.document_id, e.document_id) AS doc
      ) x
      WHERE e.organization_id = ${ctx.organizationId}::uuid
        ${where}
        ${only}
        AND x.d BETWEEN ${from}::date AND ${to}::date
        AND (e.movement_type <> 'REVERSAL' OR o.id IS NOT NULL)
        AND (x.kind IN ('CONSUMPTION', 'CUSTOMER_DELIVERY') ${transfers})
      GROUP BY e.product_id, x.d`,
    tx.$queryRaw<Array<{ product_id: string; d: Date }>>`
      SELECT e.product_id, MIN((e.occurred_at AT TIME ZONE ${tz})::date) AS d
      FROM inventory_ledger_entries e
      WHERE e.organization_id = ${ctx.organizationId}::uuid
        ${where}
        ${only}
      GROUP BY e.product_id`,
  ]);
  const firstDay = new Map(first.map((r) => [r.product_id, r.d.toISOString().slice(0, 10)]));
  const ids = productIds ?? [...new Set(daily.map((r) => r.product_id))];
  const result = new Map<string, DemandHistory>();
  for (const id of ids)
    result.set(id, {
      series: Array.from({ length: HISTORY_DAYS }, () => ZERO),
      historyDays: firstDay.has(id)
        ? Math.max(0, Math.round((ms(to) - ms(firstDay.get(id)!)) / 86_400_000) + 1)
        : 0,
    });
  for (const r of daily) {
    const h = result.get(r.product_id);
    if (!h) continue;
    const i = Math.round((ms(r.d.toISOString().slice(0, 10)) - ms(from)) / 86_400_000);
    h.series[i] = h.series[i].plus(dec(r.quantity));
  }
  return result;
}

async function loadWarehouse(tx: Tx, ctx: TenantContext, warehouseId: string) {
  const wh = await tx.warehouse.findFirst({
    where: { organizationId: ctx.organizationId, id: warehouseId },
    select: {
      id: true,
      code: true,
      name: true,
      branchId: true,
      archivedAt: true,
      branch: { select: { timeZone: true, archivedAt: true } },
    },
  });
  if (!wh || !canOnWarehouse(ctx, "purchasing.view", wh)) throw notFound("Warehouse");
  return wh;
}

export interface ForecastRow {
  product: {
    id: string;
    sku: string;
    nameEn: string;
    nameAr: string | null;
    baseUom: { code: string };
  };
  historyDays: number;
  /** Demand per week over the history, oldest first. */
  weeks: Decimal[];
  /** Average daily demand over the last 28 days. */
  recentDaily: Decimal;
  result: ForecastResult;
  /** Forecast demand over the next 7 and 28 days; null without a forecast. */
  next7: Decimal | null;
  next28: Decimal | null;
}

/**
 * Forecasts for every product that moved out of the warehouse in the last
 * HISTORY_DAYS days or has a reorder rule there. Needs `purchasing.view`
 * on the warehouse.
 */
export async function warehouseForecast(ctx: TenantContext, warehouseId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wh = await loadWarehouse(tx, ctx, warehouseId);
    const today = businessDate(wh.branch.timeZone ?? ctx.timeZone);
    const warehouse = { id: wh.id, timeZone: wh.branch.timeZone };
    const moved = await demandHistoryInTx(tx, ctx, warehouse, today);
    const ruled = await tx.reorderRule.findMany({
      where: { organizationId: ctx.organizationId, warehouseId: wh.id },
      select: { productId: true },
    });
    const missing = ruled.map((r) => r.productId).filter((id) => !moved.has(id));
    const histories = new Map([
      ...moved,
      ...(await demandHistoryInTx(tx, ctx, warehouse, today, missing)),
    ]);
    const products = await tx.product.findMany({
      where: { organizationId: ctx.organizationId, id: { in: [...histories.keys()] } },
      select: {
        id: true,
        sku: true,
        nameEn: true,
        nameAr: true,
        baseUom: { select: { code: true } },
      },
      orderBy: { sku: "asc" },
    });
    const rows: ForecastRow[] = products.map((product) => {
      const h = histories.get(product.id)!;
      const result = forecast(h.series, h.historyDays, 28);
      const total = (n: number) =>
        result.status === "OK" ? result.daily.slice(0, n).reduce((a, d) => a.plus(d), ZERO) : null;
      const recent = h.series.slice(-Math.min(28, Math.max(1, h.historyDays)));
      return {
        product,
        historyDays: h.historyDays,
        weeks: weeklyTotals(h.series),
        recentDaily: recent.reduce((a, d) => a.plus(d), ZERO).dividedBy(recent.length),
        result,
        next7: total(7),
        next28: total(28),
      };
    });
    return { warehouse: wh, today, rows };
  });
}

export async function exportForecastCsv(ctx: TenantContext, warehouseId: string) {
  const { warehouse, today, rows } = await warehouseForecast(ctx, warehouseId);
  const q = (v: Decimal | null | undefined) => (v ? v.toDecimalPlaces(3).toFixed() : "");
  const weekCount = rows[0]?.weeks.length ?? 0;
  const header = [
    "warehouse",
    "as_of",
    "sku",
    "product",
    "unit",
    "history_days",
    "average_daily_28d",
    "method",
    "wape",
    "bias",
    "next_7_days",
    "next_28_days",
    ...Array.from({ length: weekCount }, (_, i) => `week_minus_${weekCount - i}`),
  ];
  return toCsv(
    header,
    rows.map((r) => [
      warehouse.code,
      today,
      r.product.sku,
      r.product.nameEn,
      r.product.baseUom.code,
      String(r.historyDays),
      q(r.recentDaily),
      r.result.status === "OK" ? r.result.method : r.result.status,
      r.result.status === "OK" ? q(r.result.accuracy.wape) : "",
      r.result.status === "OK" ? q(r.result.accuracy.bias) : "",
      q(r.next7),
      q(r.next28),
      ...r.weeks.map((w) => q(w)),
    ]),
  );
}
