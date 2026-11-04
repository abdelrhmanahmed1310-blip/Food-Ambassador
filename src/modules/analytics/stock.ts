import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, holdsAnyGrant } from "@/modules/access/authorize";
import { currencyConverter, warehouseCurrencies } from "@/modules/fx/service";
import { businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { forbidden, validationFailed } from "@/server/errors";
import { daysBetween } from "./sales-rules";
import {
  AGE_BUCKETS,
  ageBucket,
  ageInDays,
  daysOnHand,
  fifoAges,
  turnover,
  type AgeBucket,
} from "./stock-rules";

/**
 * Stock ageing, turnover and days on hand (DECISIONS.md ADR-106), from the
 * ledger and the moving-average valuation only. Ageing is of stock on hand
 * today: lots by their first receipt, stock without lots first in first out
 * from its recorded arrivals. Turnover and days on hand are over a period:
 * usage (consumption and customer deliveries, net of their reversals) against
 * the average of the opening and closing stock value. Values are in each
 * warehouse's company currency, converted into the report currency at the
 * period's average rate. Needs `inventory.valuation.view`.
 */

const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? "0");
const day = (d: Date) => d.toISOString().slice(0, 10);

const periodSchema = z
  .object({
    from: z.string().refine(isCalendarDate, { error: "invalidDate" }),
    to: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  })
  .refine((p) => p.from <= p.to, { error: "invalidPeriod", path: ["to"] });

export const canSeeStockHealth = (ctx: TenantContext) =>
  holdsAnyGrant(ctx.grants, "inventory.valuation.view");

/** Movements that count as using stock (ADR-106). */
const USAGE = ["CONSUMPTION", "CUSTOMER_DELIVERY"] as const;
/** Movements that bring stock in, for ageing stock without lots. */
const ARRIVALS = [
  "OPENING_BALANCE",
  "RECEIPT",
  "TRANSFER_IN",
  "PRODUCTION_OUTPUT",
  "CUSTOMER_RETURN",
  "ADJUSTMENT",
  "COUNT_ADJUSTMENT",
] as const;

type Buckets = Record<AgeBucket | "UNKNOWN", Decimal>;
const emptyBuckets = (): Buckets =>
  Object.fromEntries(
    [...AGE_BUCKETS.map((b) => b.key), "UNKNOWN"].map((k) => [k, new Decimal(0)]),
  ) as Buckets;

interface Figures {
  onHandValue: Decimal;
  buckets: Buckets;
  expiredValue: Decimal;
  opening: Decimal;
  closing: Decimal;
  usage: Decimal;
  writtenOff: Decimal;
}
const zero = (): Figures => ({
  onHandValue: new Decimal(0),
  buckets: emptyBuckets(),
  expiredValue: new Decimal(0),
  opening: new Decimal(0),
  closing: new Decimal(0),
  usage: new Decimal(0),
  writtenOff: new Decimal(0),
});
function add(into: Figures, f: Figures) {
  into.onHandValue = into.onHandValue.plus(f.onHandValue);
  into.expiredValue = into.expiredValue.plus(f.expiredValue);
  into.opening = into.opening.plus(f.opening);
  into.closing = into.closing.plus(f.closing);
  into.usage = into.usage.plus(f.usage);
  into.writtenOff = into.writtenOff.plus(f.writtenOff);
  for (const k of Object.keys(into.buckets) as Array<keyof Buckets>)
    into.buckets[k] = into.buckets[k].plus(f.buckets[k]);
}

async function valuationWarehouses(
  tx: Tx,
  ctx: TenantContext,
  filters: { companyId?: string; warehouseId?: string },
) {
  if (!canSeeStockHealth(ctx)) throw forbidden();
  const scope = accessibleScope(ctx.grants, "inventory.valuation.view");
  return tx.warehouse.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(filters.companyId ? { branch: { companyId: filters.companyId } } : {}),
      ...(filters.warehouseId ? { id: filters.warehouseId } : {}),
      ...(scope.all
        ? {}
        : { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }] }),
    },
    select: { id: true, code: true, name: true, branch: { select: { timeZone: true } } },
    orderBy: { code: "asc" },
  });
}

export async function stockHealth(
  ctx: TenantContext,
  rawPeriod: unknown,
  filters: { companyId?: string; warehouseId?: string } = {},
) {
  const p = periodSchema.safeParse(rawPeriod);
  if (!p.success) throw validationFailed(p.error);
  const period = p.data;
  const today = businessDate(ctx.timeZone);
  const days = daysBetween(period.from, period.to);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const warehouses = await valuationWarehouses(tx, ctx, filters);
    const ids = warehouses.map((w) => w.id);
    const currency =
      (filters.companyId
        ? (
            await tx.company.findFirst({
              where: { organizationId: ctx.organizationId, id: filters.companyId },
              select: { currency: true },
            })
          )?.currency
        : undefined) ?? ctx.groupCurrency;
    const conv = await currencyConverter(tx, ctx, {
      to: currency,
      date: period.to,
      from: period.from,
    });
    const currencies = await warehouseCurrencies(tx, ctx, ids);
    const convert = (v: Decimal, warehouseId: string) =>
      conv.convert(v, currencies.get(warehouseId)!);

    const usage = Prisma.join(USAGE.map((t) => Prisma.sql`${t}::"MovementType"`));
    const movement = ids.length
      ? await tx.$queryRaw<
          Array<{
            warehouse_id: string;
            product_id: string;
            opening: Prisma.Decimal | null;
            closing: Prisma.Decimal | null;
            used: Prisma.Decimal | null;
            written_off: Prisma.Decimal | null;
          }>
        >`
          SELECT e.warehouse_id, e.product_id,
            SUM(e.value_delta) FILTER (WHERE x.d < ${period.from}::date) AS opening,
            SUM(e.value_delta) AS closing,
            -SUM(e.value_delta) FILTER (WHERE x.d >= ${period.from}::date AND (
               e.movement_type IN (${usage})
               OR (e.movement_type = 'REVERSAL' AND o.movement_type IN (${usage})))) AS used,
            -SUM(e.value_delta) FILTER (WHERE x.d >= ${period.from}::date AND (
               e.movement_type = 'WRITE_OFF'
               OR (e.movement_type = 'REVERSAL' AND o.movement_type = 'WRITE_OFF'))) AS written_off
          FROM inventory_ledger_entries e
          JOIN warehouses w ON w.id = e.warehouse_id
          JOIN branches b ON b.id = w.branch_id
          LEFT JOIN inventory_ledger_entries o ON o.id = e.reverses_entry_id
          CROSS JOIN LATERAL (
            SELECT (e.occurred_at AT TIME ZONE coalesce(b.time_zone, ${ctx.timeZone}))::date AS d
          ) x
          WHERE e.organization_id = ${ctx.organizationId}::uuid
            AND e.warehouse_id = ANY(${ids}::uuid[])
            AND x.d <= ${period.to}::date
          GROUP BY e.warehouse_id, e.product_id`
      : [];

    // Stock on hand today, with lots, and the moving average cost.
    const balances = ids.length
      ? await tx.stockBalance.findMany({
          where: {
            organizationId: ctx.organizationId,
            warehouseId: { in: ids },
            onHandQuantity: { gt: 0 },
          },
          select: {
            warehouseId: true,
            productId: true,
            lotId: true,
            onHandQuantity: true,
            lot: { select: { firstReceivedAt: true, expiresOn: true } },
          },
        })
      : [];
    const valuations = ids.length
      ? await tx.stockValuation.findMany({
          where: { organizationId: ctx.organizationId, warehouseId: { in: ids } },
          select: { warehouseId: true, productId: true, averageUnitCost: true, costMissing: true },
        })
      : [];
    const costOf = new Map(valuations.map((v) => [`${v.warehouseId}|${v.productId}`, v]));
    const unlotted = new Map<string, Decimal>();
    for (const b of balances)
      if (!b.lotId) {
        const k = `${b.warehouseId}|${b.productId}`;
        unlotted.set(k, (unlotted.get(k) ?? new Decimal(0)).plus(dec(b.onHandQuantity)));
      }
    const arrivalRows = unlotted.size
      ? await tx.$queryRaw<
          Array<{ warehouse_id: string; product_id: string; d: Date; quantity: Prisma.Decimal }>
        >`
          SELECT e.warehouse_id, e.product_id,
                 (e.occurred_at AT TIME ZONE coalesce(b.time_zone, ${ctx.timeZone}))::date AS d,
                 SUM(e.quantity_delta) AS quantity
          FROM inventory_ledger_entries e
          JOIN warehouses w ON w.id = e.warehouse_id
          JOIN branches b ON b.id = w.branch_id
          WHERE e.organization_id = ${ctx.organizationId}::uuid
            AND e.warehouse_id = ANY(${ids}::uuid[])
            AND e.lot_id IS NULL AND e.quantity_delta > 0
            AND e.movement_type IN (${Prisma.join(ARRIVALS.map((t) => Prisma.sql`${t}::"MovementType"`))})
          GROUP BY 1, 2, 3`
      : [];

    // Per warehouse × product, in the warehouse's currency first.
    const rows = new Map<
      string,
      Figures & {
        warehouseId: string;
        productId: string;
        quantity: Decimal;
        oldestAgeDays: number | null;
        costMissing: boolean;
      }
    >();
    const row = (warehouseId: string, productId: string) => {
      const k = `${warehouseId}|${productId}`;
      let r = rows.get(k);
      if (!r) {
        r = {
          ...zero(),
          warehouseId,
          productId,
          quantity: new Decimal(0),
          oldestAgeDays: null,
          costMissing: false,
        };
        rows.set(k, r);
      }
      return r;
    };
    const age = (
      r: ReturnType<typeof row>,
      ageDays: number | null,
      quantity: Decimal,
      unitCost: Decimal,
    ) => {
      const value = quantity.times(unitCost);
      r.onHandValue = r.onHandValue.plus(value);
      r.quantity = r.quantity.plus(quantity);
      const key = ageDays === null ? "UNKNOWN" : ageBucket(ageDays);
      r.buckets[key] = r.buckets[key].plus(value);
      if (ageDays !== null && (r.oldestAgeDays === null || ageDays > r.oldestAgeDays))
        r.oldestAgeDays = ageDays;
    };
    for (const b of balances) {
      const v = costOf.get(`${b.warehouseId}|${b.productId}`);
      const unit = dec(v?.averageUnitCost ?? 0);
      const r = row(b.warehouseId, b.productId);
      if (!v?.averageUnitCost || v.costMissing) r.costMissing = true;
      if (!b.lotId) continue;
      const q = dec(b.onHandQuantity);
      age(r, b.lot ? ageInDays(day(b.lot.firstReceivedAt), today) : null, q, unit);
      if (b.lot?.expiresOn && day(b.lot.expiresOn) < today)
        r.expiredValue = r.expiredValue.plus(q.times(unit));
    }
    for (const [k, onHand] of unlotted) {
      const [warehouseId, productId] = k.split("|");
      const unit = dec(costOf.get(k)?.averageUnitCost ?? 0);
      const arrivals = arrivalRows
        .filter((a) => a.warehouse_id === warehouseId && a.product_id === productId)
        .map((a) => ({ date: day(a.d), quantity: dec(a.quantity) }));
      for (const piece of fifoAges(onHand, arrivals, today))
        age(row(warehouseId, productId), piece.ageDays, piece.quantity, unit);
    }
    for (const m of movement) {
      const r = row(m.warehouse_id, m.product_id);
      r.opening = dec(m.opening);
      r.closing = dec(m.closing);
      r.usage = dec(m.used);
      r.writtenOff = dec(m.written_off);
    }

    // Convert, then roll up.
    const products = await tx.product.findMany({
      where: {
        organizationId: ctx.organizationId,
        id: { in: [...new Set([...rows.values()].map((r) => r.productId))] },
      },
      select: {
        id: true,
        sku: true,
        nameEn: true,
        nameAr: true,
        baseUom: { select: { code: true } },
        category: { select: { name: true, nameAr: true } },
      },
    });
    const productOf = new Map(products.map((p) => [p.id, p]));
    const warehouseOf = new Map(warehouses.map((w) => [w.id, w]));
    const total = zero();
    const perWarehouse = new Map(warehouses.map((w) => [w.id, zero()]));
    const out = [];
    for (const r of rows.values()) {
      const c = zero();
      let ok = true;
      for (const field of [
        "onHandValue",
        "expiredValue",
        "opening",
        "closing",
        "usage",
        "writtenOff",
      ] as const) {
        const v = await convert(r[field], r.warehouseId);
        if (v === null) ok = false;
        else c[field] = v;
      }
      for (const k of Object.keys(c.buckets) as Array<keyof Buckets>) {
        const v = await convert(r.buckets[k], r.warehouseId);
        if (v === null) ok = false;
        else c.buckets[k] = v;
      }
      if (!ok) continue;
      add(total, c);
      add(perWarehouse.get(r.warehouseId)!, c);
      if (r.quantity.isZero() && c.usage.isZero() && c.closing.isZero() && c.writtenOff.isZero())
        continue;
      out.push({
        warehouse: warehouseOf.get(r.warehouseId)!,
        product: productOf.get(r.productId)!,
        quantity: r.quantity,
        oldestAgeDays: r.oldestAgeDays,
        costMissing: r.costMissing,
        ...c,
        turnover: turnover(c.usage, c.opening, c.closing),
        daysOnHand: daysOnHand(c.closing, c.usage, days),
        slowMover: r.quantity.gt(0) && c.usage.isZero(),
      });
    }
    out.sort((a, b) => b.onHandValue.comparedTo(a.onHandValue));
    const ratios = (f: Figures) => ({
      ...f,
      turnover: turnover(f.usage, f.opening, f.closing),
      daysOnHand: daysOnHand(f.closing, f.usage, days),
    });
    return {
      period,
      days,
      today,
      currency: conv.currency,
      missingRates: conv.missing(),
      total: ratios(total),
      warehouses: warehouses.map((w) => ({ warehouse: w, ...ratios(perWarehouse.get(w.id)!) })),
      products: out.slice(0, 500),
      slowMovers: out.filter((r) => r.slowMover).length,
    };
  });
}

export async function exportStockHealthCsv(
  ctx: TenantContext,
  rawPeriod: unknown,
  filters: { companyId?: string; warehouseId?: string } = {},
) {
  const r = await stockHealth(ctx, rawPeriod, filters);
  const f = (v: Decimal | null) => (v === null ? "" : v.toFixed(2));
  return toCsv(
    [
      "warehouse",
      "sku",
      "product",
      "quantity",
      "unit",
      `value now (${r.currency})`,
      "0-30 days",
      "31-60 days",
      "61-90 days",
      "91-180 days",
      "over 180 days",
      "age unknown",
      "expired",
      "oldest (days)",
      "opening",
      "closing",
      "used",
      "written off",
      "turnover",
      "days on hand",
      "slow mover",
    ],
    r.products.map((p) => [
      p.warehouse.code,
      p.product.sku,
      p.product.nameEn,
      p.quantity.toFixed(),
      p.product.baseUom.code,
      f(p.onHandValue),
      f(p.buckets.D0_30),
      f(p.buckets.D31_60),
      f(p.buckets.D61_90),
      f(p.buckets.D91_180),
      f(p.buckets.D181_PLUS),
      f(p.buckets.UNKNOWN),
      f(p.expiredValue),
      p.oldestAgeDays ?? "",
      f(p.opening),
      f(p.closing),
      f(p.usage),
      f(p.writtenOff),
      f(p.turnover),
      p.daysOnHand === null ? "" : p.daysOnHand.toFixed(1),
      p.slowMover ? "yes" : "",
    ]),
  );
}
