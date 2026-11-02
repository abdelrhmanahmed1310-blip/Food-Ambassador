import "server-only";
import { currencyConverter, warehouseCurrencies } from "@/modules/fx/service";
import { Prisma } from "@/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, holdsAnyGrant } from "@/modules/access/authorize";
import type { Permission } from "@/modules/access/permissions";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { currencyDecimals } from "@/modules/tax/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { forbidden, validationFailed } from "@/server/errors";
import { lastMonths, monthOf, monthRange, ratio, splitByPeriod } from "./rules";
import { z } from "zod";

/**
 * Reports from recorded data only (DECISIONS.md ADR-042): waste and stock
 * differences from the ledger, actual food cost from sales imports, and a
 * branch comparison. Values need `inventory.valuation.view`, sales figures
 * `sales.view`, each at the sites where the user holds them.
 */

const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? "0");

const periodSchema = z
  .object({
    from: z.string().refine(isCalendarDate, { error: "invalidDate" }),
    to: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  })
  .refine((p) => p.from <= p.to, { error: "invalidPeriod", path: ["to"] });

function parsePeriod(raw: unknown) {
  const p = periodSchema.safeParse(raw);
  if (!p.success) throw validationFailed(p.error);
  return p.data;
}

/** Warehouses the user may see for `permission`; throws when none. */
async function visibleWarehouses(
  tx: Tx,
  ctx: TenantContext,
  permission: Permission,
  /** Only the warehouses of one company's branches (ADR-083). */
  companyId?: string,
) {
  if (!holdsAnyGrant(ctx.grants, permission)) throw forbidden();
  const scope = accessibleScope(ctx.grants, permission);
  return tx.warehouse.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(companyId ? { branch: { companyId } } : {}),
      ...(scope.all
        ? {}
        : { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }] }),
    },
    select: {
      id: true,
      code: true,
      name: true,
      branchId: true,
      branch: { select: { id: true, code: true, name: true } },
    },
    orderBy: { code: "asc" },
  });
}

export function canSeeReports(ctx: TenantContext) {
  return {
    waste: holdsAnyGrant(ctx.grants, "inventory.valuation.view"),
    foodCost:
      holdsAnyGrant(ctx.grants, "sales.view") &&
      holdsAnyGrant(ctx.grants, "inventory.valuation.view"),
  };
}

type Converter = Awaited<ReturnType<typeof currencyConverter>>;

// ─── Waste and stock differences ───

type LossKind = "WASTE" | "DIFFERENCE";
interface LossRow {
  kind: LossKind;
  warehouseId: string;
  productId: string;
  reason: string;
  quantity: Decimal;
  value: Decimal;
  costMissing: boolean;
}

/**
 * Write-offs (waste) and adjustments plus count differences, net of their
 * reversals, by business date in the organization's time zone. Positive
 * values are losses; a negative difference is stock found.
 */
async function lossesInTx(
  tx: Tx,
  ctx: TenantContext,
  warehouseIds: string[],
  period: { from: string; to: string },
  /** Values are converted from each warehouse's currency into the report's (ADR-086). */
  conv: Converter,
): Promise<LossRow[]> {
  if (warehouseIds.length === 0) return [];
  const rows = await tx.$queryRaw<
    Array<{
      kind: LossKind;
      warehouse_id: string;
      product_id: string;
      reason: string;
      quantity: Prisma.Decimal;
      value: Prisma.Decimal;
      cost_missing: boolean;
    }>
  >`
    SELECT CASE WHEN COALESCE(o.movement_type, e.movement_type) = 'WRITE_OFF' THEN 'WASTE' ELSE 'DIFFERENCE' END AS kind,
           e.warehouse_id, e.product_id,
           COALESCE(o.reason_code, e.reason_code, '') AS reason,
           -SUM(e.quantity_delta) AS quantity,
           -SUM(e.value_delta) AS value,
           BOOL_OR(COALESCE(o.cost_source, e.cost_source) = 'NONE') AS cost_missing
    FROM inventory_ledger_entries e
    LEFT JOIN inventory_ledger_entries o ON o.id = e.reverses_entry_id
    WHERE e.organization_id = ${ctx.organizationId}::uuid
      AND e.warehouse_id = ANY(${warehouseIds}::uuid[])
      AND COALESCE(o.movement_type, e.movement_type) IN ('WRITE_OFF', 'ADJUSTMENT', 'COUNT_ADJUSTMENT')
      AND (e.occurred_at AT TIME ZONE ${ctx.timeZone})::date BETWEEN ${period.from}::date AND ${period.to}::date
    GROUP BY 1, 2, 3, 4
    HAVING SUM(e.quantity_delta) <> 0 OR SUM(e.value_delta) <> 0`;
  const currencies = await warehouseCurrencies(tx, ctx, warehouseIds);
  const out: LossRow[] = [];
  for (const r of rows) {
    const value = await conv.convert(dec(r.value), currencies.get(r.warehouse_id)!);
    if (value === null) continue; // no usable rate: listed in conv.missing()
    out.push({
      kind: r.kind,
      warehouseId: r.warehouse_id,
      productId: r.product_id,
      reason: r.reason,
      quantity: dec(r.quantity),
      value,
      costMissing: r.cost_missing,
    });
  }
  return out;
}

export async function wasteReport(
  ctx: TenantContext,
  rawPeriod: unknown,
  options: { warehouseId?: string } = {},
) {
  const period = parsePeriod(rawPeriod);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const warehouses = await visibleWarehouses(tx, ctx, "inventory.valuation.view");
    const ids = warehouses
      .map((w) => w.id)
      .filter((id) => !options.warehouseId || id === options.warehouseId);
    const conv = await currencyConverter(tx, ctx, { date: period.to, from: period.from });
    const rows = await lossesInTx(tx, ctx, ids, period, conv);
    const products = await tx.product.findMany({
      where: {
        organizationId: ctx.organizationId,
        id: { in: [...new Set(rows.map((r) => r.productId))] },
      },
      select: {
        id: true,
        sku: true,
        nameEn: true,
        nameAr: true,
        baseUom: { select: { code: true } },
      },
    });
    const byReason = new Map<string, { kind: LossKind; reason: string; value: Decimal }>();
    const total = { WASTE: new Decimal(0), DIFFERENCE: new Decimal(0) };
    for (const r of rows) {
      const key = `${r.kind}:${r.reason}`;
      const e = byReason.get(key) ?? { kind: r.kind, reason: r.reason, value: new Decimal(0) };
      e.value = e.value.plus(r.value);
      byReason.set(key, e);
      total[r.kind] = total[r.kind].plus(r.value);
    }
    return {
      period,
      warehouses,
      rows: rows
        .map((r) => ({
          ...r,
          product: products.find((p) => p.id === r.productId)!,
          warehouse: warehouses.find((w) => w.id === r.warehouseId)!,
        }))
        .sort((a, b) => b.value.comparedTo(a.value)),
      byReason: [...byReason.values()].sort((a, b) => b.value.comparedTo(a.value)),
      total,
      costMissing: rows.some((r) => r.costMissing),
      /** Values are in this currency; `missingRates` were left out for want of a rate (ADR-086). */
      currency: conv.currency,
      missingRates: conv.missing(),
    };
  });
}

// ─── Food cost and branch comparison ───

async function importsInTx(
  tx: Tx,
  ctx: TenantContext,
  warehouseIds: string[],
  from: string,
  to: string,
) {
  if (warehouseIds.length === 0) return [];
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      number: string;
      warehouse_id: string;
      first_sale: Date;
      last_sale: Date;
      net: Prisma.Decimal | null;
      cost: Prisma.Decimal;
      lines_without_net: bigint;
    }>
  >`
    SELECT i.id, i.number, i.warehouse_id,
           MIN(l.sold_on) AS first_sale, MAX(l.sold_on) AS last_sale,
           SUM(l.net_amount) AS net, i.cost_amount AS cost,
           COUNT(*) FILTER (WHERE l.net_amount IS NULL) AS lines_without_net
    FROM sales_imports i
    JOIN sales_lines l ON l.import_id = i.id AND l.active
    WHERE i.organization_id = ${ctx.organizationId}::uuid
      AND i.status = 'POSTED'
      AND i.warehouse_id = ANY(${warehouseIds}::uuid[])
    GROUP BY i.id
    HAVING MAX(l.sold_on) >= ${from}::date AND MIN(l.sold_on) <= ${to}::date
    ORDER BY MIN(l.sold_on), i.number`;
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    warehouseId: r.warehouse_id,
    firstSale: r.first_sale.toISOString().slice(0, 10),
    lastSale: r.last_sale.toISOString().slice(0, 10),
    // Net sales are known only when every line has them.
    net: r.lines_without_net > BigInt(0) || r.net === null ? null : dec(r.net),
    cost: dec(r.cost),
  }));
}

/**
 * Point-of-sale sales per warehouse whose business date is in the period
 * (ADR-059): paid orders' net less refunded net; cost is the stock they used,
 * including shortfalls posted later. Voided orders are left out (their stock
 * went back).
 */
async function posSalesInTx(
  tx: Tx,
  ctx: TenantContext,
  warehouseIds: string[],
  from: string,
  to: string,
) {
  if (warehouseIds.length === 0) return [];
  const rows = await tx.$queryRaw<
    Array<{
      warehouse_id: string;
      orders: bigint;
      net: Prisma.Decimal;
      cost: Prisma.Decimal;
      discounts: Prisma.Decimal;
    }>
  >`
    SELECT o.warehouse_id, COUNT(*) AS orders,
           SUM(o.net_amount) - COALESCE(SUM(r.net), 0) AS net,
           SUM(o.cost_amount) AS cost,
           SUM(o.promo_discount + o.order_discount) AS discounts
    FROM pos_orders o
    LEFT JOIN (
      SELECT order_id, SUM(amount - tax_amount) AS net FROM pos_refunds
      WHERE organization_id = ${ctx.organizationId}::uuid GROUP BY order_id
    ) r ON r.order_id = o.id
    WHERE o.organization_id = ${ctx.organizationId}::uuid
      AND o.status = 'PAID'
      AND o.warehouse_id = ANY(${warehouseIds}::uuid[])
      AND o.business_date BETWEEN ${from}::date AND ${to}::date
    GROUP BY o.warehouse_id`;
  return rows.map((r) => ({
    warehouseId: r.warehouse_id,
    orders: Number(r.orders),
    net: dec(r.net),
    cost: dec(r.cost),
    discounts: dec(r.discounts),
  }));
}

/** Warehouses the user may see for both sales and stock value. */
async function foodCostWarehouses(tx: Tx, ctx: TenantContext, companyId?: string) {
  const sales = await visibleWarehouses(tx, ctx, "sales.view", companyId);
  const values = new Set(
    (await visibleWarehouses(tx, ctx, "inventory.valuation.view")).map((w) => w.id),
  );
  return sales.filter((w) => values.has(w.id));
}

export interface BranchFigures {
  branch: { id: string; code: string; name: string };
  imports: number;
  /** Point-of-sale orders in the period (ADR-059). */
  posOrders: number;
  net: Decimal | null;
  cost: Decimal;
  foodCost: Decimal | null;
  waste: Decimal;
  differences: Decimal;
  /** (cost of sales + waste + differences) ÷ net sales. */
  costWithLosses: Decimal | null;
  /** Promotions and order discounts given at the point of sale, VAT included (ADR-067). */
  discounts: Decimal;
}

export async function foodCostReport(ctx: TenantContext, rawPeriod: unknown, companyId?: string) {
  const period = parsePeriod(rawPeriod);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const warehouses = await foodCostWarehouses(tx, ctx, companyId);
    const ids = warehouses.map((w) => w.id);
    const all = await importsInTx(tx, ctx, ids, period.from, period.to);
    const { inside, straddling } = splitByPeriod(all, period.from, period.to);
    // One company's report is in its own currency; the group's in the group currency (ADR-086).
    const reportCurrency = companyId
      ? (
          await tx.company.findFirst({
            where: { organizationId: ctx.organizationId, id: companyId },
            select: { currency: true },
          })
        )?.currency
      : undefined;
    const conv = await currencyConverter(tx, ctx, {
      to: reportCurrency,
      date: period.to,
      from: period.from,
    });
    const losses = await lossesInTx(tx, ctx, ids, period, conv);
    const pos = await posSalesInTx(tx, ctx, ids, period.from, period.to);
    const branches = new Map<string, BranchFigures>();
    const of = (warehouseId: string) => {
      const w = warehouses.find((x) => x.id === warehouseId)!;
      let b = branches.get(w.branch.id);
      if (!b) {
        b = {
          branch: w.branch,
          imports: 0,
          posOrders: 0,
          net: new Decimal(0),
          cost: new Decimal(0),
          foodCost: null,
          waste: new Decimal(0),
          differences: new Decimal(0),
          costWithLosses: null,
          discounts: new Decimal(0),
        };
        branches.set(w.branch.id, b);
      }
      return b;
    };
    for (const i of inside) {
      const b = of(i.warehouseId);
      b.imports += 1;
      b.cost = b.cost.plus(i.cost);
      b.net = b.net === null || i.net === null ? null : b.net.plus(i.net);
    }
    for (const p of pos) {
      const b = of(p.warehouseId);
      b.posOrders += p.orders;
      b.discounts = b.discounts.plus(p.discounts);
      b.cost = b.cost.plus(p.cost);
      b.net = b.net === null ? null : b.net.plus(p.net);
    }
    for (const l of losses) {
      const b = of(l.warehouseId);
      if (l.kind === "WASTE") b.waste = b.waste.plus(l.value);
      else b.differences = b.differences.plus(l.value);
    }
    const total: Omit<BranchFigures, "branch"> = {
      imports: 0,
      posOrders: 0,
      net: new Decimal(0),
      cost: new Decimal(0),
      foodCost: null,
      waste: new Decimal(0),
      differences: new Decimal(0),
      costWithLosses: null,
      discounts: new Decimal(0),
    };
    for (const b of branches.values()) {
      const sold = b.imports > 0 || b.posOrders > 0;
      if (!sold) b.net = null;
      b.foodCost = ratio(b.cost, b.net);
      b.costWithLosses = ratio(b.cost.plus(b.waste).plus(b.differences), b.net);
      total.imports += b.imports;
      total.posOrders += b.posOrders;
      total.cost = total.cost.plus(b.cost);
      total.waste = total.waste.plus(b.waste);
      total.differences = total.differences.plus(b.differences);
      total.discounts = total.discounts.plus(b.discounts);
      if (sold) total.net = total.net === null || b.net === null ? null : total.net.plus(b.net);
    }
    if (total.imports === 0 && total.posOrders === 0) total.net = null;
    total.foodCost = ratio(total.cost, total.net);
    total.costWithLosses = ratio(total.cost.plus(total.waste).plus(total.differences), total.net);
    return {
      period,
      currency: conv.currency,
      missingRates: conv.missing(),
      branches: [...branches.values()].sort((a, b) => a.branch.code.localeCompare(b.branch.code)),
      total,
      included: inside.map((i) => ({
        ...i,
        warehouse: warehouses.find((w) => w.id === i.warehouseId)!,
      })),
      straddling: straddling.map((i) => ({
        ...i,
        warehouse: warehouses.find((w) => w.id === i.warehouseId)!,
      })),
    };
  });
}

/** Food cost % per branch per month, from imports that fall within one month. */
export async function foodCostTrend(ctx: TenantContext, months = 12) {
  const list = lastMonths(businessDate(ctx.timeZone), Math.min(Math.max(months, 1), 24));
  const from = monthRange(list[0]).from;
  const to = monthRange(list.at(-1)!).to;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const warehouses = await foodCostWarehouses(tx, ctx);
    const imports = await importsInTx(
      tx,
      ctx,
      warehouses.map((w) => w.id),
      from,
      to,
    );
    const cells = new Map<string, { net: Decimal | null; cost: Decimal }>();
    const branchIds = new Set<string>();
    for (const i of imports) {
      const month = monthOf(i);
      if (!month || !list.includes(month)) continue;
      const branch = warehouses.find((w) => w.id === i.warehouseId)!.branch;
      branchIds.add(branch.id);
      const key = `${branch.id}:${month}`;
      const c = cells.get(key) ?? { net: new Decimal(0), cost: new Decimal(0) };
      c.cost = c.cost.plus(i.cost);
      c.net = c.net === null || i.net === null ? null : c.net.plus(i.net);
      cells.set(key, c);
    }
    const branches = [...new Map(warehouses.map((w) => [w.branch.id, w.branch])).values()]
      .filter((b) => branchIds.has(b.id))
      .sort((a, b) => a.code.localeCompare(b.code));
    return {
      months: list,
      rows: branches.map((b) => ({
        branch: b,
        cells: list.map((m) => {
          const c = cells.get(`${b.id}:${m}`);
          return c
            ? { month: m, foodCost: ratio(c.cost, c.net), cost: c.cost, net: c.net }
            : { month: m, foodCost: null, cost: null, net: null };
        }),
      })),
    };
  });
}

// ─── CSV ───

const money = (ctx: TenantContext) => (v: Decimal | null) =>
  v === null ? null : v.toFixed(currencyDecimals(ctx.baseCurrency));
const quantity = (v: Decimal) => v.toDecimalPlaces(6).toFixed();
const percent = (v: Decimal | null) => (v === null ? null : v.times(100).toFixed(2));

export async function exportWasteCsv(ctx: TenantContext, rawPeriod: unknown) {
  const r = await wasteReport(ctx, rawPeriod);
  const fixed = money(ctx);
  return toCsv(
    ["kind", "warehouse", "sku", "product", "reason", "quantity", "unit", "value", "cost_missing"],
    r.rows.map((row) => [
      row.kind,
      row.warehouse.code,
      row.product.sku,
      row.product.nameEn,
      row.reason,
      quantity(row.quantity),
      row.product.baseUom.code,
      fixed(row.value),
      row.costMissing ? "yes" : "",
    ]),
  );
}

export async function exportBranchComparisonCsv(ctx: TenantContext, rawPeriod: unknown) {
  const r = await foodCostReport(ctx, rawPeriod);
  const fixed = money(ctx);
  return toCsv(
    [
      "branch",
      "imports",
      "pos_orders",
      "net_sales",
      "cost_of_sales",
      "food_cost_pct",
      "waste",
      "stock_differences",
      "cost_with_losses_pct",
      "discounts_given",
    ],
    r.branches.map((b) => [
      b.branch.code,
      b.imports,
      b.posOrders,
      fixed(b.net),
      fixed(b.cost),
      percent(b.foodCost),
      fixed(b.waste),
      fixed(b.differences),
      percent(b.costWithLosses),
      fixed(b.discounts),
    ]),
  );
}

// ─── Overview dashboard ───

export const DASHBOARD_DAYS = 14;

/**
 * Point-of-sale figures for the overview (ADR-078), from paid orders in the
 * warehouses the user may see sales for: net sales per business day for the
 * last 14 days (refunds deducted on the order's day), today's orders and
 * average ticket, and the best sellers of the period. Food cost and waste
 * come from the food cost report, only for users who may see costs.
 * Nothing is estimated: days without orders are zero.
 */
export async function salesDashboard(ctx: TenantContext, rawCompanyId?: unknown) {
  // Only this company's branches (ADR-083); anything else means the whole group.
  const companyId = z
    .uuid()
    .optional()
    .catch(undefined)
    .parse(rawCompanyId || undefined);
  if (!holdsAnyGrant(ctx.grants, "sales.view")) return null;
  const today = businessDate(ctx.timeZone);
  const from = addDays(today, -(DASHBOARD_DAYS - 1));
  const sales = await withTenantTx(ctx.organizationId, async (tx) => {
    const ids = (await visibleWarehouses(tx, ctx, "sales.view", companyId)).map((w) => w.id);
    const currency =
      (companyId
        ? (
            await tx.company.findFirst({
              where: { organizationId: ctx.organizationId, id: companyId },
              select: { currency: true },
            })
          )?.currency
        : undefined) ?? ctx.groupCurrency;
    if (ids.length === 0) return { days: [], top: [], currency };
    const days = await tx.$queryRaw<Array<{ day: Date; orders: bigint; net: Prisma.Decimal }>>`
      SELECT o.business_date AS day, COUNT(*) AS orders,
             SUM(o.net_amount) - COALESCE(SUM(r.net), 0) AS net
      FROM pos_orders o
      LEFT JOIN (
        SELECT order_id, SUM(amount - tax_amount) AS net FROM pos_refunds
        WHERE organization_id = ${ctx.organizationId}::uuid GROUP BY order_id
      ) r ON r.order_id = o.id
      WHERE o.organization_id = ${ctx.organizationId}::uuid
        AND o.status = 'PAID'
        AND o.warehouse_id = ANY(${ids}::uuid[])
        AND o.business_date BETWEEN ${from}::date AND ${today}::date
      GROUP BY o.business_date`;
    const top = await tx.$queryRaw<
      Array<{ name: string; quantity: Prisma.Decimal; net: Prisma.Decimal }>
    >`
      SELECT l.name, SUM(l.quantity - l.refunded_quantity) AS quantity, SUM(l.net_amount) AS net
      FROM pos_order_lines l
      JOIN pos_orders o ON o.id = l.order_id
      WHERE o.organization_id = ${ctx.organizationId}::uuid
        AND o.status = 'PAID'
        AND o.warehouse_id = ANY(${ids}::uuid[])
        AND o.business_date BETWEEN ${from}::date AND ${today}::date
      GROUP BY l.name
      ORDER BY SUM(l.net_amount) DESC
      LIMIT 5`;
    return { days, top, currency };
  });
  const byDay = new Map(
    sales.days.map((d) => [
      d.day.toISOString().slice(0, 10),
      { orders: Number(d.orders), net: dec(d.net) },
    ]),
  );
  const series = Array.from({ length: DASHBOARD_DAYS }, (_, i) => {
    const day = addDays(from, i);
    const d = byDay.get(day);
    return { day, orders: d?.orders ?? 0, net: d?.net ?? new Decimal(0) };
  });
  const todayFigures = series[series.length - 1];
  const periodNet = series.reduce((a, d) => a.plus(d.net), new Decimal(0));
  const periodOrders = series.reduce((a, d) => a + d.orders, 0);
  const costs = canSeeReports(ctx).foodCost
    ? await foodCostReport(ctx, { from, to: today }, companyId)
    : null;
  return {
    /** Figures are in the group's currency, or the chosen company's (ADR-086). */
    currency: sales.currency,
    missingRates: costs?.missingRates ?? [],
    from,
    to: today,
    series,
    today: {
      orders: todayFigures.orders,
      net: todayFigures.net,
      averageTicket:
        todayFigures.orders > 0 ? todayFigures.net.dividedBy(todayFigures.orders) : null,
    },
    period: { orders: periodOrders, net: periodNet },
    top: sales.top.map((t) => ({ name: t.name, quantity: dec(t.quantity), net: dec(t.net) })),
    /** Only for users who may see costs (sales and stock value). */
    costs: costs
      ? {
          foodCost: costs.total.foodCost,
          waste: costs.total.waste,
          discounts: costs.total.discounts,
        }
      : null,
  };
}
