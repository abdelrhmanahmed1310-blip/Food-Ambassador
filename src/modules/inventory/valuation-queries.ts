import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, hasPermission } from "@/modules/access/authorize";
import type { Permission } from "@/modules/access/permissions";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx } from "@/server/db/transactions";
import { notFound } from "@/server/errors";
import { PAGE_SIZE } from "./queries";

/** Stock value reports (ADR-021). Costs are visible only with `inventory.valuation.view`. */

function scopedWarehouses(ctx: TenantContext, permission: Permission): Prisma.WarehouseWhereInput {
  const scope = accessibleScope(ctx.grants, permission);
  if (scope.all) return {};
  return { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }] };
}

/** True when the user may see costs in at least one warehouse. */
export function canViewValuation(ctx: TenantContext): boolean {
  const scope = accessibleScope(ctx.grants, "inventory.valuation.view");
  return scope.all || scope.branchIds.length > 0 || scope.warehouseIds.length > 0;
}

const dec = (v: { toString(): string }) => new Decimal(v.toString());

export interface ValuationFilters {
  warehouseId?: string;
  q?: string;
  costMissing?: boolean;
  page?: number;
}

const valuationSelect = {
  id: true,
  quantity: true,
  totalValue: true,
  averageUnitCost: true,
  costMissing: true,
  updatedAt: true,
  warehouse: { select: { id: true, code: true, name: true, branchId: true } },
  product: {
    select: {
      id: true,
      sku: true,
      nameEn: true,
      nameAr: true,
      baseUom: { select: { code: true } },
    },
  },
} satisfies Prisma.StockValuationSelect;

type ValuationRecord = Prisma.StockValuationGetPayload<{ select: typeof valuationSelect }>;

function toRow(r: ValuationRecord) {
  return {
    id: r.id,
    warehouse: r.warehouse,
    product: {
      id: r.product.id,
      sku: r.product.sku,
      nameEn: r.product.nameEn,
      nameAr: r.product.nameAr,
      baseUom: r.product.baseUom.code,
    },
    quantity: dec(r.quantity),
    totalValue: dec(r.totalValue),
    averageUnitCost: r.averageUnitCost === null ? null : dec(r.averageUnitCost),
    costMissing: r.costMissing,
    updatedAt: r.updatedAt,
  };
}

export type ValuationRow = ReturnType<typeof toRow>;

/** Stock on hand with its average cost and value, per product × warehouse. */
export async function listValuations(ctx: TenantContext, filters: ValuationFilters = {}) {
  const page = Math.max(1, filters.page ?? 1);
  const q = filters.q?.trim();
  const where: Prisma.StockValuationWhereInput = {
    organizationId: ctx.organizationId,
    quantity: { gt: 0 },
    warehouse: scopedWarehouses(ctx, "inventory.valuation.view"),
    ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    ...(filters.costMissing ? { costMissing: true } : {}),
    ...(q
      ? {
          OR: [
            { product: { sku: { contains: q, mode: "insensitive" } } },
            { product: { nameEn: { contains: q, mode: "insensitive" } } },
            { product: { nameAr: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, totals, missing, rows] = await inSequence([
      tx.stockValuation.count({ where }),
      tx.stockValuation.aggregate({ where, _sum: { totalValue: true } }),
      tx.stockValuation.count({ where: { ...where, costMissing: true } }),
      tx.stockValuation.findMany({
        where,
        select: valuationSelect,
        orderBy: [{ product: { sku: "asc" } }, { warehouse: { code: "asc" } }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return {
      items: rows.map(toRow),
      total,
      totalValue: dec(totals._sum.totalValue ?? 0),
      costMissingCount: missing,
      page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
  });
}

/** Value per warehouse (dashboard), within the user's valuation scope. */
export async function valuationByWarehouse(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const where: Prisma.StockValuationWhereInput = {
      organizationId: ctx.organizationId,
      quantity: { gt: 0 },
      warehouse: scopedWarehouses(ctx, "inventory.valuation.view"),
    };
    const [groups, missing] = await inSequence([
      tx.stockValuation.groupBy({ by: ["warehouseId"], where, _sum: { totalValue: true } }),
      tx.stockValuation.groupBy({
        by: ["warehouseId"],
        where: { ...where, costMissing: true },
        _count: { _all: true },
      }),
    ]);
    const warehouses = await tx.warehouse.findMany({
      where: { organizationId: ctx.organizationId, id: { in: groups.map((g) => g.warehouseId) } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    });
    const value = new Map(groups.map((g) => [g.warehouseId, dec(g._sum.totalValue ?? 0)]));
    const missingBy = new Map(missing.map((m) => [m.warehouseId, m._count._all]));
    const rows = warehouses.map((w) => ({
      warehouse: w,
      totalValue: value.get(w.id)!,
      costMissingCount: missingBy.get(w.id) ?? 0,
    }));
    return {
      rows,
      totalValue: rows.reduce((acc, r) => acc.plus(r.totalValue), new Decimal(0)),
      costMissingCount: rows.reduce((acc, r) => acc + r.costMissingCount, 0),
    };
  });
}

/** One product × warehouse valuation for the revaluation form. */
export async function getValuation(ctx: TenantContext, warehouseId: string, productId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wh = await tx.warehouse.findFirst({
      where: { organizationId: ctx.organizationId, id: warehouseId },
      select: { id: true, branchId: true },
    });
    const product = await tx.product.findFirst({
      where: { organizationId: ctx.organizationId, id: productId },
      select: { id: true },
    });
    // Not found (rather than forbidden) so warehouse IDs cannot be probed.
    if (
      !wh ||
      !product ||
      !hasPermission(ctx.grants, "inventory.valuation.view", {
        branchId: wh.branchId,
        warehouseId: wh.id,
      })
    )
      throw notFound("Valuation");
    const row = await tx.stockValuation.findFirst({
      where: { organizationId: ctx.organizationId, warehouseId, productId },
      select: valuationSelect,
    });
    if (!row) throw notFound("Valuation");
    return toRow(row);
  });
}

/**
 * Integrity check: every valuation's quantity equals its stock balances and
 * its value equals the sum of ledger value changes plus revaluations. Must
 * return no rows (asserted in the integration suites).
 */
export async function reconcileValuations(ctx: TenantContext) {
  return withTenantTx(
    ctx.organizationId,
    (tx) =>
      tx.$queryRaw<
        Array<{
          warehouse_id: string;
          product_id: string;
          quantity: string;
          balance_quantity: string;
          total_value: string;
          ledger_value: string;
        }>
      >`
      WITH org AS (SELECT ${ctx.organizationId}::uuid AS id),
      balances AS (
        SELECT "warehouse_id", "product_id", SUM("on_hand_quantity") AS qty
        FROM "stock_balances", org WHERE "organization_id" = org.id GROUP BY 1, 2
      ),
      ledger AS (
        SELECT "warehouse_id", "product_id", SUM("value_delta") AS value
        FROM "inventory_ledger_entries", org WHERE "organization_id" = org.id GROUP BY 1, 2
      ),
      revaluations AS (
        SELECT "warehouse_id", "product_id", SUM("value_delta") AS value
        FROM "stock_revaluations", org WHERE "organization_id" = org.id GROUP BY 1, 2
      ),
      expected AS (
        SELECT COALESCE(b."warehouse_id", l."warehouse_id") AS warehouse_id,
               COALESCE(b."product_id", l."product_id") AS product_id,
               COALESCE(b.qty, 0) AS qty,
               COALESCE(l.value, 0) + COALESCE(r.value, 0) AS value
        FROM balances b
        FULL OUTER JOIN ledger l ON l."warehouse_id" = b."warehouse_id" AND l."product_id" = b."product_id"
        LEFT JOIN revaluations r
          ON r."warehouse_id" = COALESCE(b."warehouse_id", l."warehouse_id")
         AND r."product_id" = COALESCE(b."product_id", l."product_id")
      )
      SELECT COALESCE(v."warehouse_id", e.warehouse_id) AS warehouse_id,
             COALESCE(v."product_id", e.product_id) AS product_id,
             COALESCE(v."quantity", 0)::text AS quantity, COALESCE(e.qty, 0)::text AS balance_quantity,
             COALESCE(v."total_value", 0)::text AS total_value, COALESCE(e.value, 0)::text AS ledger_value
      FROM (SELECT v.* FROM "stock_valuations" v, org WHERE v."organization_id" = org.id) v
      FULL OUTER JOIN expected e ON e.warehouse_id = v."warehouse_id" AND e.product_id = v."product_id"
      WHERE COALESCE(v."quantity", 0) <> COALESCE(e.qty, 0)
         OR COALESCE(v."total_value", 0) <> COALESCE(e.value, 0)`,
  );
}
