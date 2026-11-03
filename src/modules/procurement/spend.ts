import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { isCalendarDate } from "@/lib/dates";
import { Decimal } from "@/lib/decimal";
import { toCsv } from "@/lib/csv";
import { accessibleScope, holdsAnyGrant } from "@/modules/access/authorize";
import { currencyDecimals } from "@/modules/tax/rules";
import { currencyConverter, warehouseCurrencies } from "@/modules/fx/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { forbidden, validationFailed } from "@/server/errors";
import {
  groupSpend,
  previousPeriod,
  priceChanges,
  topShare,
  type ReceivedRow,
  type ReturnedRow,
} from "./spend-rules";

/**
 * Spend and purchase price variance (DECISIONS.md ADR-095), from what was
 * actually received: posted receipts' accepted lines valued at the charged
 * price and the receipt's own exchange rate (the stock value, ADR-050/086),
 * less goods returned to suppliers in the period (ADR-094). One company's
 * report is in its currency; the group's is converted into the group
 * currency at the period's average rates, and currencies without a rate are
 * named and left out. Users see the warehouses where they may view
 * purchasing.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());

const periodSchema = z
  .object({
    from: z.string().refine(isCalendarDate, { error: "invalidDate" }),
    to: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  })
  .refine((p) => p.from <= p.to, { error: "invalidPeriod", path: ["to"] });

export const canSeeSpend = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "purchasing.view");

async function warehousesFor(tx: Tx, ctx: TenantContext, companyId?: string) {
  if (!canSeeSpend(ctx)) throw forbidden();
  const scope = accessibleScope(ctx.grants, "purchasing.view");
  return tx.warehouse.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(companyId ? { branch: { companyId } } : {}),
      ...(scope.all
        ? {}
        : { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }] }),
    },
    select: { id: true, branchId: true },
  });
}

interface LineDetail {
  lineId: string;
  receiptId: string;
  receiptNumber: string;
  receivedOn: string;
  currency: string;
  uom: string;
  acceptedQuantity: Decimal;
  unitPrice: Decimal;
  orderedUnitPrice: Decimal;
}

/** Received and returned rows for a period, valued in the report currency. */
async function rowsInTx(
  tx: Tx,
  ctx: TenantContext,
  warehouseIds: string[],
  period: { from: string; to: string },
  conv: Awaited<ReturnType<typeof currencyConverter>>,
) {
  const received: Array<ReceivedRow & LineDetail> = [];
  const returned: ReturnedRow[] = [];
  if (warehouseIds.length === 0) return { received, returned };
  const companyCurrency = await warehouseCurrencies(tx, ctx, warehouseIds);
  const recv = await tx.$queryRaw<
    Array<{
      line_id: string;
      receipt_id: string;
      receipt_number: string;
      received_on: string;
      supplier_id: string;
      product_id: string;
      category_id: string | null;
      branch_id: string;
      warehouse_id: string;
      currency: string;
      uom: string;
      accepted_quantity: Prisma.Decimal;
      accepted_quantity_base: Prisma.Decimal;
      unit_price: Prisma.Decimal;
      ordered_unit_price: Prisma.Decimal;
      exchange_rate: Prisma.Decimal;
    }>
  >`
    SELECT gl.id AS line_id, g.id AS receipt_id, g.number AS receipt_number,
           to_char((g.received_at AT TIME ZONE ${ctx.timeZone})::date, 'YYYY-MM-DD') AS received_on,
           g.supplier_id, gl.product_id, p.category_id, w.branch_id, g.warehouse_id, g.currency,
           u.code AS uom, gl.accepted_quantity, gl.accepted_quantity_base, gl.unit_price,
           gl.ordered_unit_price, g.exchange_rate
    FROM goods_receipt_lines gl
    JOIN goods_receipts g ON g.organization_id = gl.organization_id AND g.id = gl.receipt_id
    JOIN products p ON p.organization_id = gl.organization_id AND p.id = gl.product_id
    JOIN warehouses w ON w.organization_id = g.organization_id AND w.id = g.warehouse_id
    JOIN units_of_measure u ON u.id = gl.uom_id
    WHERE gl.organization_id = ${ctx.organizationId}::uuid
      AND g.status = 'POSTED' AND gl.accepted_quantity > 0
      AND g.warehouse_id = ANY(${warehouseIds}::uuid[])
      AND (g.received_at AT TIME ZONE ${ctx.timeZone})::date BETWEEN ${period.from}::date AND ${period.to}::date`;
  for (const r of recv) {
    const rate = dec(r.exchange_rate);
    const qty = dec(r.accepted_quantity);
    const from = companyCurrency.get(r.warehouse_id)!;
    const value = await conv.convert(qty.times(dec(r.unit_price)).times(rate), from);
    const variance = await conv.convert(
      dec(r.unit_price).minus(dec(r.ordered_unit_price)).times(qty).times(rate),
      from,
    );
    if (value === null || variance === null) continue; // listed in conv.missing()
    received.push({
      supplierId: r.supplier_id,
      productId: r.product_id,
      categoryId: r.category_id,
      branchId: r.branch_id,
      month: r.received_on.slice(0, 7),
      value,
      variance,
      quantityBase: dec(r.accepted_quantity_base),
      lineId: r.line_id,
      receiptId: r.receipt_id,
      receiptNumber: r.receipt_number,
      receivedOn: r.received_on,
      currency: r.currency,
      uom: r.uom,
      acceptedQuantity: qty,
      unitPrice: dec(r.unit_price),
      orderedUnitPrice: dec(r.ordered_unit_price),
    });
  }
  const rets = await tx.$queryRaw<
    Array<{
      supplier_id: string;
      product_id: string;
      category_id: string | null;
      branch_id: string;
      warehouse_id: string;
      posted_on: string;
      quantity: Prisma.Decimal;
      unit_price: Prisma.Decimal;
      exchange_rate: Prisma.Decimal;
    }>
  >`
    SELECT r.supplier_id, l.product_id, p.category_id, w.branch_id, r.warehouse_id,
           to_char((r.posted_at AT TIME ZONE ${ctx.timeZone})::date, 'YYYY-MM-DD') AS posted_on,
           l.quantity, l.unit_price, g.exchange_rate
    FROM supplier_return_lines l
    JOIN supplier_returns r ON r.organization_id = l.organization_id AND r.id = l.return_id
    JOIN goods_receipt_lines gl ON gl.organization_id = l.organization_id AND gl.id = l.receipt_line_id
    JOIN goods_receipts g ON g.organization_id = gl.organization_id AND g.id = gl.receipt_id
    JOIN products p ON p.organization_id = l.organization_id AND p.id = l.product_id
    JOIN warehouses w ON w.organization_id = r.organization_id AND w.id = r.warehouse_id
    WHERE l.organization_id = ${ctx.organizationId}::uuid
      AND r.status IN ('POSTED', 'CREDITED')
      AND r.warehouse_id = ANY(${warehouseIds}::uuid[])
      AND (r.posted_at AT TIME ZONE ${ctx.timeZone})::date BETWEEN ${period.from}::date AND ${period.to}::date`;
  for (const r of rets) {
    const value = await conv.convert(
      dec(r.quantity).times(dec(r.unit_price)).times(dec(r.exchange_rate)),
      companyCurrency.get(r.warehouse_id)!,
    );
    if (value === null) continue;
    returned.push({
      supplierId: r.supplier_id,
      productId: r.product_id,
      categoryId: r.category_id,
      branchId: r.branch_id,
      month: r.posted_on.slice(0, 7),
      value,
    });
  }
  return { received, returned };
}

async function setup(tx: Tx, ctx: TenantContext, rawPeriod: unknown, companyId?: string) {
  const p = periodSchema.safeParse(rawPeriod);
  if (!p.success) throw validationFailed(p.error);
  const period = p.data;
  const warehouses = await warehousesFor(tx, ctx, companyId);
  const reportCurrency = companyId
    ? (
        await tx.company.findFirst({
          where: { organizationId: ctx.organizationId, id: companyId },
          select: { currency: true },
        })
      )?.currency
    : undefined;
  return { period, warehouses, reportCurrency };
}

async function namesInTx(
  tx: Tx,
  ctx: TenantContext,
  ids: { suppliers: string[]; products: string[]; categories: string[]; branches: string[] },
) {
  const org = ctx.organizationId;
  const [suppliers, products, categories, branches] = [
    await tx.supplier.findMany({
      where: { organizationId: org, id: { in: ids.suppliers } },
      select: { id: true, code: true, name: true, nameAr: true },
    }),
    await tx.product.findMany({
      where: { organizationId: org, id: { in: ids.products } },
      select: {
        id: true,
        sku: true,
        nameEn: true,
        nameAr: true,
        baseUom: { select: { code: true } },
      },
    }),
    await tx.productCategory.findMany({
      where: { organizationId: org, id: { in: ids.categories } },
      select: { id: true, code: true, name: true, nameAr: true },
    }),
    await tx.branch.findMany({
      where: { organizationId: org, id: { in: ids.branches } },
      select: { id: true, code: true, name: true },
    }),
  ];
  return {
    supplier: new Map(suppliers.map((s) => [s.id, s])),
    product: new Map(products.map((p) => [p.id, p])),
    category: new Map(categories.map((c) => [c.id, c])),
    branch: new Map(branches.map((b) => [b.id, b])),
  };
}

const uniq = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))];

/** Spend by supplier, category, branch and month, with concentration and single-source categories. */
export async function spendReport(ctx: TenantContext, rawPeriod: unknown, companyId?: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { period, warehouses, reportCurrency } = await setup(tx, ctx, rawPeriod, companyId);
    const conv = await currencyConverter(tx, ctx, {
      to: reportCurrency,
      date: period.to,
      from: period.from,
    });
    const { received, returned } = await rowsInTx(
      tx,
      ctx,
      warehouses.map((w) => w.id),
      period,
      conv,
    );
    const all = [...received, ...returned];
    const names = await namesInTx(tx, ctx, {
      suppliers: uniq(all.map((r) => r.supplierId)),
      products: [],
      categories: uniq(all.map((r) => r.categoryId)),
      branches: uniq(all.map((r) => r.branchId)),
    });
    const suppliers = groupSpend(received, returned, (r) => r.supplierId);
    const categories = groupSpend(received, returned, (r) => r.categoryId);
    const total = suppliers.reduce(
      (a, g) => ({
        received: a.received.plus(g.received),
        returned: a.returned.plus(g.returned),
        net: a.net.plus(g.net),
        lines: a.lines + g.lines,
        variance: a.variance.plus(g.variance),
      }),
      {
        received: new Decimal(0),
        returned: new Decimal(0),
        net: new Decimal(0),
        lines: 0,
        variance: new Decimal(0),
      },
    );
    return {
      period,
      currency: conv.currency,
      missingRates: conv.missing(),
      total: { ...total, suppliers: suppliers.length },
      top5Share: topShare(suppliers, 5),
      suppliers: suppliers.map((g) => ({ ...g, supplier: names.supplier.get(g.key!)! })),
      categories: categories.map((g) => ({
        ...g,
        category: g.key ? (names.category.get(g.key) ?? null) : null,
        singleSource: g.suppliers === 1 && g.net.greaterThan(0),
      })),
      branches: groupSpend(received, returned, (r) => r.branchId).map((g) => ({
        ...g,
        branch: names.branch.get(g.key!)!,
      })),
      months: groupSpend(received, returned, (r) => r.month).sort((a, b) =>
        String(a.key).localeCompare(String(b.key)),
      ),
    };
  });
}

/**
 * Purchase price variance: what was charged against the order price (per
 * receipt line), and each product's average price against the previous
 * period of the same length.
 */
export async function priceVarianceReport(
  ctx: TenantContext,
  rawPeriod: unknown,
  companyId?: string,
) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { period, warehouses, reportCurrency } = await setup(tx, ctx, rawPeriod, companyId);
    const previous = previousPeriod(period.from, period.to);
    const ids = warehouses.map((w) => w.id);
    const conv = await currencyConverter(tx, ctx, {
      to: reportCurrency,
      date: period.to,
      from: period.from,
    });
    const convBefore = await currencyConverter(tx, ctx, {
      to: reportCurrency,
      date: previous.to,
      from: previous.from,
    });
    const now = (await rowsInTx(tx, ctx, ids, period, conv)).received;
    const before = (await rowsInTx(tx, ctx, ids, previous, convBefore)).received;
    const changes = priceChanges(now, before).slice(0, 100);
    const varied = now
      .filter((r) => !r.variance.isZero())
      .sort((a, b) => b.variance.comparedTo(a.variance))
      .slice(0, 100);
    const names = await namesInTx(tx, ctx, {
      suppliers: uniq(now.map((r) => r.supplierId)),
      products: uniq([...changes.map((c) => c.productId), ...varied.map((r) => r.productId)]),
      categories: [],
      branches: [],
    });
    const bySupplier = groupSpend(now, [], (r) => r.supplierId)
      .map((g) => ({
        ...g,
        supplier: names.supplier.get(g.key!)!,
        /** Variance as a share of what was spent with the supplier. */
        rate: g.received.isZero() ? null : g.variance.dividedBy(g.received),
      }))
      .sort((a, b) => b.variance.comparedTo(a.variance));
    const sum = (f: (v: Decimal) => boolean) =>
      now.reduce((a, r) => (f(r.variance) ? a.plus(r.variance) : a), new Decimal(0));
    return {
      period,
      previous,
      currency: conv.currency,
      missingRates: [...new Set([...conv.missing(), ...convBefore.missing()])].sort(),
      total: {
        spend: now.reduce((a, r) => a.plus(r.value), new Decimal(0)),
        unfavourable: sum((v) => v.greaterThan(0)),
        favourable: sum((v) => v.lessThan(0)),
        net: sum(() => true),
        linesWithVariance: now.filter((r) => !r.variance.isZero()).length,
        lines: now.length,
      },
      suppliers: bySupplier,
      lines: varied.map((r) => ({
        ...r,
        supplier: names.supplier.get(r.supplierId)!,
        product: names.product.get(r.productId)!,
      })),
      changes: changes.map((c) => ({ ...c, product: names.product.get(c.productId)! })),
    };
  });
}

// ─── Exports ───

const fixed = (currency: string) => (v: Decimal | null) =>
  v === null ? "" : v.toFixed(currencyDecimals(currency));
const pct = (v: Decimal | null) => (v === null ? "" : v.times(100).toFixed(2));

export async function exportSpendCsv(ctx: TenantContext, rawPeriod: unknown, companyId?: string) {
  const r = await spendReport(ctx, rawPeriod, companyId);
  const m = fixed(r.currency);
  return toCsv(
    [
      "supplier_code",
      "supplier",
      "received",
      "returned",
      "net",
      "share_percent",
      "lines",
      "price_variance",
      "currency",
    ],
    r.suppliers.map((s) => [
      s.supplier.code,
      s.supplier.name,
      m(s.received),
      m(s.returned),
      m(s.net),
      pct(s.share),
      String(s.lines),
      m(s.variance),
      r.currency,
    ]),
  );
}

export async function exportPriceVarianceCsv(
  ctx: TenantContext,
  rawPeriod: unknown,
  companyId?: string,
) {
  const r = await priceVarianceReport(ctx, rawPeriod, companyId);
  const m = fixed(r.currency);
  return toCsv(
    [
      "received_on",
      "receipt",
      "supplier_code",
      "sku",
      "product",
      "quantity",
      "unit",
      "document_currency",
      "ordered_price",
      "charged_price",
      "variance",
      "report_currency",
    ],
    r.lines.map((l) => [
      l.receivedOn,
      l.receiptNumber,
      l.supplier.code,
      l.product.sku,
      l.product.nameEn,
      l.acceptedQuantity.toFixed(),
      l.uom,
      l.currency,
      l.orderedUnitPrice.toFixed(),
      l.unitPrice.toFixed(),
      m(l.variance),
      r.currency,
    ]),
  );
}
