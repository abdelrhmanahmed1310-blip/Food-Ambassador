import "server-only";
import type { MovementType, Prisma, StockStatus } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, hasPermission } from "@/modules/access/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { notFound } from "@/server/errors";
import { loadWarehouse } from "./context";
import { addDays, businessDate, expiryState, fefoSort, isExpired, type ExpiryState } from "./rules";

/** Default "expiring soon" window for dashboards and filters. */
export const EXPIRY_WARNING_DAYS = 7;
export const PAGE_SIZE = 50;

/** Warehouses the user may see inventory for, as a Prisma filter. */
function warehouseScope(ctx: TenantContext): Prisma.WarehouseWhereInput {
  const scope = accessibleScope(ctx.grants, "inventory.view");
  if (scope.all) return {};
  return { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }] };
}

const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const dec = (v: { toString(): string }) => new Decimal(v.toString());

export interface BalanceRow {
  id: string;
  warehouse: { id: string; code: string; name: string; branchId: string };
  location: { id: string; code: string } | null;
  product: { id: string; sku: string; nameEn: string; nameAr: string | null; baseUom: string };
  lot: { id: string; lotCode: string; expiresOn: string | null; recallHold: boolean } | null;
  stockStatus: StockStatus;
  onHand: Decimal;
  reserved: Decimal;
  /** Freely usable: AVAILABLE, not expired, not on recall hold, minus reservations. */
  available: Decimal;
  expiry: ExpiryState;
}

export interface BalanceFilters {
  warehouseId?: string;
  productId?: string;
  q?: string;
  status?: StockStatus;
  expiry?: "expired" | "expiring";
  page?: number;
}

/** Today's business date (organization time zone) for list views. */
export function orgToday(ctx: TenantContext) {
  return businessDate(ctx.timeZone);
}

export async function listBalances(ctx: TenantContext, filters: BalanceFilters = {}) {
  const today = orgToday(ctx);
  const page = Math.max(1, filters.page ?? 1);
  const q = filters.q?.trim();
  const where: Prisma.StockBalanceWhereInput = {
    organizationId: ctx.organizationId,
    onHandQuantity: { gt: 0 },
    warehouse: warehouseScope(ctx),
    ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    ...(filters.productId ? { productId: filters.productId } : {}),
    ...(filters.status ? { stockStatus: filters.status } : {}),
    ...(q
      ? {
          OR: [
            { product: { sku: { contains: q, mode: "insensitive" } } },
            { product: { nameEn: { contains: q, mode: "insensitive" } } },
            { product: { nameAr: { contains: q, mode: "insensitive" } } },
            { lot: { lotCode: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
    ...(filters.expiry === "expired"
      ? { lot: { expiresOn: { lt: new Date(`${today}T00:00:00Z`) } } }
      : filters.expiry === "expiring"
        ? {
            lot: {
              expiresOn: {
                gte: new Date(`${today}T00:00:00Z`),
                lte: new Date(`${addDays(today, EXPIRY_WARNING_DAYS)}T00:00:00Z`),
              },
            },
          }
        : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, rows] = await inSequence([
      tx.stockBalance.count({ where }),
      tx.stockBalance.findMany({
        where,
        select: balanceSelect,
        orderBy: [
          { product: { sku: "asc" } },
          { lot: { expiresOn: { sort: "asc", nulls: "last" } } },
          { warehouse: { code: "asc" } },
        ],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return {
      items: rows.map((r) => toBalanceRow(r, today)),
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      today,
    };
  });
}

const balanceSelect = {
  id: true,
  stockStatus: true,
  onHandQuantity: true,
  reservedQuantity: true,
  warehouse: { select: { id: true, code: true, name: true, branchId: true } },
  location: { select: { id: true, code: true } },
  product: {
    select: {
      id: true,
      sku: true,
      nameEn: true,
      nameAr: true,
      baseUom: { select: { code: true } },
    },
  },
  lot: { select: { id: true, lotCode: true, expiresOn: true, recallHold: true } },
} satisfies Prisma.StockBalanceSelect;

type BalanceRecord = Prisma.StockBalanceGetPayload<{ select: typeof balanceSelect }>;

function toBalanceRow(r: BalanceRecord, today: string): BalanceRow {
  const onHand = dec(r.onHandQuantity);
  const reserved = dec(r.reservedQuantity);
  const lot = r.lot
    ? {
        id: r.lot.id,
        lotCode: r.lot.lotCode,
        expiresOn: dateOnly(r.lot.expiresOn),
        recallHold: r.lot.recallHold,
      }
    : null;
  const usable =
    r.stockStatus === "AVAILABLE" && !(lot && (lot.recallHold || isExpired(lot.expiresOn, today)));
  return {
    id: r.id,
    warehouse: r.warehouse,
    location: r.location,
    product: {
      id: r.product.id,
      sku: r.product.sku,
      nameEn: r.product.nameEn,
      nameAr: r.product.nameAr,
      baseUom: r.product.baseUom.code,
    },
    lot,
    stockStatus: r.stockStatus,
    onHand,
    reserved,
    available: usable ? Decimal.max(onHand.minus(reserved), 0) : new Decimal(0),
    expiry: expiryState(lot?.expiresOn ?? null, today, EXPIRY_WARNING_DAYS),
  };
}

/** One balance bucket, for action forms (transfer, write-off, status change). */
export async function getBalance(ctx: TenantContext, balanceId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const row = await tx.stockBalance.findFirst({
      where: { organizationId: ctx.organizationId, id: balanceId, warehouse: warehouseScope(ctx) },
      select: balanceSelect,
    });
    if (!row) throw notFound("Stock");
    return toBalanceRow(row, orgToday(ctx));
  });
}

/** Totals per warehouse and status for one product (product page). */
export async function productStockSummary(ctx: TenantContext, productId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const groups = await tx.stockBalance.groupBy({
      by: ["warehouseId", "stockStatus"],
      where: {
        organizationId: ctx.organizationId,
        productId,
        onHandQuantity: { gt: 0 },
        warehouse: warehouseScope(ctx),
      },
      _sum: { onHandQuantity: true },
    });
    const warehouses = await tx.warehouse.findMany({
      where: {
        organizationId: ctx.organizationId,
        id: { in: [...new Set(groups.map((g) => g.warehouseId))] },
      },
      select: { id: true, code: true, name: true },
    });
    const byId = new Map(warehouses.map((w) => [w.id, w]));
    return groups.map((g) => ({
      warehouse: byId.get(g.warehouseId)!,
      stockStatus: g.stockStatus,
      onHand: dec(g._sum.onHandQuantity ?? 0),
    }));
  });
}

export interface MovementFilters {
  warehouseId?: string;
  productId?: string;
  lotId?: string;
  movementType?: MovementType;
  page?: number;
}

export async function listMovements(ctx: TenantContext, filters: MovementFilters = {}) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.InventoryLedgerEntryWhereInput = {
    organizationId: ctx.organizationId,
    warehouse: warehouseScope(ctx),
    ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    ...(filters.productId ? { productId: filters.productId } : {}),
    ...(filters.lotId ? { lotId: filters.lotId } : {}),
    ...(filters.movementType ? { movementType: filters.movementType } : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.inventoryLedgerEntry.count({ where }),
      tx.inventoryLedgerEntry.findMany({
        where,
        select: movementSelect,
        orderBy: [{ postedAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return {
      items: await withActorNames(tx, redactCosts(ctx, items)),
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
  });
}

const movementSelect = {
  id: true,
  movementType: true,
  stockStatus: true,
  quantityDelta: true,
  enteredQuantity: true,
  unitCost: true,
  valueDelta: true,
  costSource: true,
  reasonCode: true,
  note: true,
  postedAt: true,
  postedByUserId: true,
  reversesEntryId: true,
  document: { select: { id: true, number: true, type: true } },
  warehouse: { select: { id: true, code: true, branchId: true } },
  location: { select: { code: true } },
  product: {
    select: {
      id: true,
      sku: true,
      nameEn: true,
      nameAr: true,
      baseUom: { select: { code: true } },
    },
  },
  lot: { select: { id: true, lotCode: true, expiresOn: true } },
  enteredUom: { select: { code: true } },
} satisfies Prisma.InventoryLedgerEntrySelect;

type MovementRecord = Prisma.InventoryLedgerEntryGetPayload<{ select: typeof movementSelect }>;

/** Costs and values are shown only where the user holds `inventory.valuation.view`. */
function redactCosts(ctx: TenantContext, rows: MovementRecord[]) {
  return rows.map((r) => {
    const visible = hasPermission(ctx.grants, "inventory.valuation.view", {
      branchId: r.warehouse.branchId,
      warehouseId: r.warehouse.id,
    });
    return visible
      ? { ...r, costVisible: true as const }
      : { ...r, unitCost: null, valueDelta: null, costSource: null, costVisible: false as const };
  });
}

async function withActorNames<T extends { postedByUserId: string }>(tx: Tx, rows: T[]) {
  const users = await tx.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.postedByUserId))] } },
    select: { id: true, name: true },
  });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({ ...r, postedByName: names.get(r.postedByUserId) ?? null }));
}

export async function getDocument(ctx: TenantContext, documentId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const doc = await tx.inventoryDocument.findFirst({
      where: { organizationId: ctx.organizationId, id: documentId },
      select: {
        id: true,
        number: true,
        type: true,
        reasonCode: true,
        note: true,
        occurredAt: true,
        postedAt: true,
        postedByUserId: true,
        warehouseId: true,
        destinationWarehouseId: true,
        warehouse: { select: { code: true, name: true } },
        destination: { select: { code: true, name: true } },
        reverses: { select: { id: true, number: true } },
        reversedBy: { select: { id: true, number: true } },
        stockCount: { select: { id: true, number: true } },
        receipt: { select: { id: true, number: true } },
        landedCost: {
          select: {
            amount: true,
            chargeType: true,
            receipt: { select: { id: true, number: true } },
          },
        },
        revaluation: {
          select: {
            quantity: true,
            previousUnitCost: true,
            newUnitCost: true,
            previousValue: true,
            newValue: true,
            valueDelta: true,
            product: {
              select: {
                id: true,
                sku: true,
                nameEn: true,
                nameAr: true,
                baseUom: { select: { code: true } },
              },
            },
          },
        },
        entries: { select: movementSelect, orderBy: { id: "asc" } },
      },
    });
    if (!doc) throw notFound("Document");
    // Visibility: the user must see inventory of the document's warehouse.
    const wh = await loadWarehouse(tx, ctx, doc.warehouseId);
    const [withNames] = await withActorNames(tx, [doc]);
    const canReverse =
      doc.type !== "REVERSAL" &&
      doc.type !== "REVALUATION" &&
      doc.type !== "RECEIPT" &&
      doc.type !== "DISPATCH" &&
      doc.type !== "TRANSIT_RECEIPT" &&
      doc.type !== "LANDED_COST" &&
      !doc.reversedBy &&
      hasPermission(ctx.grants, "inventory.reverse", { branchId: wh.branchId, warehouseId: wh.id });
    const costVisible = hasPermission(ctx.grants, "inventory.valuation.view", {
      branchId: wh.branchId,
      warehouseId: wh.id,
    });
    return {
      ...withNames,
      entries: redactCosts(ctx, doc.entries),
      revaluation: costVisible ? doc.revaluation : null,
      landedCost: doc.landedCost
        ? { ...doc.landedCost, amount: costVisible ? doc.landedCost.amount : null }
        : null,
      costVisible,
      canReverse,
    };
  });
}

export async function listDocuments(ctx: TenantContext, options: { page?: number } = {}) {
  const page = Math.max(1, options.page ?? 1);
  const where: Prisma.InventoryDocumentWhereInput = {
    organizationId: ctx.organizationId,
    warehouse: warehouseScope(ctx),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.inventoryDocument.count({ where }),
      tx.inventoryDocument.findMany({
        where,
        select: {
          id: true,
          number: true,
          type: true,
          reasonCode: true,
          postedAt: true,
          postedByUserId: true,
          warehouse: { select: { code: true } },
          destination: { select: { code: true } },
          reversedBy: { select: { number: true } },
          _count: { select: { entries: true } },
        },
        orderBy: { postedAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return {
      items: await withActorNames(tx, items),
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
  });
}

/** FEFO-ordered usable stock of a product in a warehouse (picking suggestions). */
export async function fefoSuggestions(ctx: TenantContext, warehouseId: string, productId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wh = await loadWarehouse(tx, ctx, warehouseId);
    const today = businessDate(wh.timeZone);
    const rows = await tx.stockBalance.findMany({
      where: {
        organizationId: ctx.organizationId,
        warehouseId,
        productId,
        stockStatus: "AVAILABLE",
        onHandQuantity: { gt: 0 },
      },
      select: {
        ...balanceSelect,
        lot: {
          select: {
            id: true,
            lotCode: true,
            expiresOn: true,
            bestBeforeOn: true,
            recallHold: true,
            firstReceivedAt: true,
          },
        },
      },
    });
    const candidates = rows
      .map((r) => {
        const row = toBalanceRow(
          {
            ...r,
            lot: r.lot
              ? {
                  id: r.lot.id,
                  lotCode: r.lot.lotCode,
                  expiresOn: r.lot.expiresOn,
                  recallHold: r.lot.recallHold,
                }
              : null,
          },
          today,
        );
        return {
          ...row,
          lotId: r.lot?.id ?? null,
          expiresOn: row.lot?.expiresOn ?? null,
          bestBeforeOn: dateOnly(r.lot?.bestBeforeOn ?? null),
          firstReceivedAt: r.lot?.firstReceivedAt ?? new Date(0),
        };
      })
      .filter((c) => c.available.greaterThan(0));
    return fefoSort(candidates);
  });
}

/** Dashboard figures computed from current balances (no estimates). */
export async function inventoryDashboard(
  ctx: TenantContext,
  options: { warehouseId?: string } = {},
) {
  const today = orgToday(ctx);
  const base: Prisma.StockBalanceWhereInput = {
    organizationId: ctx.organizationId,
    onHandQuantity: { gt: 0 },
    warehouse: warehouseScope(ctx),
    ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
  };
  const todayDate = new Date(`${today}T00:00:00Z`);
  const soonDate = new Date(`${addDays(today, EXPIRY_WARNING_DAYS)}T00:00:00Z`);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [productsInStock, quarantined, onHold, rejected, expired, expiring, openCounts, recent] =
      await inSequence([
        tx.stockBalance.findMany({
          where: { ...base, stockStatus: "AVAILABLE" },
          distinct: ["productId"],
          select: { productId: true },
        }),
        tx.stockBalance.count({ where: { ...base, stockStatus: "QUARANTINE" } }),
        tx.stockBalance.count({ where: { ...base, stockStatus: "ON_HOLD" } }),
        tx.stockBalance.count({ where: { ...base, stockStatus: "REJECTED" } }),
        tx.stockBalance.findMany({
          where: { ...base, stockStatus: "AVAILABLE", lot: { expiresOn: { lt: todayDate } } },
          select: balanceSelect,
          orderBy: { lot: { expiresOn: "asc" } },
          take: 10,
        }),
        tx.stockBalance.findMany({
          where: {
            ...base,
            stockStatus: "AVAILABLE",
            lot: { expiresOn: { gte: todayDate, lte: soonDate } },
          },
          select: balanceSelect,
          orderBy: { lot: { expiresOn: "asc" } },
          take: 10,
        }),
        tx.stockCount.count({
          where: {
            organizationId: ctx.organizationId,
            status: { in: ["OPEN", "SUBMITTED"] },
            warehouse: warehouseScope(ctx),
            ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
          },
        }),
        tx.inventoryDocument.findMany({
          where: {
            organizationId: ctx.organizationId,
            warehouse: warehouseScope(ctx),
            ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
          },
          select: { id: true, number: true, type: true, postedAt: true },
          orderBy: { postedAt: "desc" },
          take: 8,
        }),
      ]);
    return {
      today,
      productsInStock: productsInStock.length,
      quarantinedBuckets: quarantined,
      onHoldBuckets: onHold,
      rejectedBuckets: rejected,
      expired: expired.map((r) => toBalanceRow(r, today)),
      expiring: expiring.map((r) => toBalanceRow(r, today)),
      openCounts,
      recentDocuments: recent,
    };
  });
}

/**
 * Recompute every balance from the ledger and report differences. Must
 * always be empty; used by tests and as an operational integrity check.
 */
export async function reconcileBalances(ctx: TenantContext) {
  return withTenantTx(
    ctx.organizationId,
    (tx) =>
      tx.$queryRaw<
        Array<{
          warehouse_id: string;
          product_id: string;
          lot_id: string | null;
          stock_status: string;
          ledger: string;
          balance: string;
        }>
      >`
      WITH ledger AS (
        SELECT "warehouse_id", "location_id", "product_id", "lot_id", "stock_status", SUM("quantity_delta") AS qty
        FROM "inventory_ledger_entries" WHERE "organization_id" = ${ctx.organizationId}::uuid
        GROUP BY 1, 2, 3, 4, 5
      )
      SELECT COALESCE(l."warehouse_id", b."warehouse_id") AS warehouse_id, COALESCE(l."product_id", b."product_id") AS product_id,
             COALESCE(l."lot_id", b."lot_id") AS lot_id, COALESCE(l."stock_status", b."stock_status")::text AS stock_status,
             COALESCE(l.qty, 0)::text AS ledger, COALESCE(b."on_hand_quantity", 0)::text AS balance
      FROM ledger l
      FULL OUTER JOIN (SELECT * FROM "stock_balances" WHERE "organization_id" = ${ctx.organizationId}::uuid) b
        ON b."warehouse_id" = l."warehouse_id" AND b."location_id" IS NOT DISTINCT FROM l."location_id"
       AND b."product_id" = l."product_id" AND b."lot_id" IS NOT DISTINCT FROM l."lot_id" AND b."stock_status" = l."stock_status"
      WHERE COALESCE(l.qty, 0) <> COALESCE(b."on_hand_quantity", 0)`,
  );
}

/** Warehouses (and their active locations) where the user holds `permission`, for pickers. */
export async function warehouseOptions(
  ctx: TenantContext,
  permission:
    | "inventory.view"
    | "inventory.adjust"
    | "inventory.transfer"
    | "inventory.count"
    | "inventory.valuation.view" = "inventory.view",
) {
  const scope = accessibleScope(ctx.grants, permission);
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.warehouse.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        branch: { archivedAt: null },
        ...(scope.all
          ? {}
          : { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }] }),
      },
      select: {
        id: true,
        code: true,
        name: true,
        locations: {
          where: { archivedAt: null },
          select: { id: true, code: true, name: true },
          orderBy: { code: "asc" },
        },
      },
      orderBy: { code: "asc" },
    }),
  );
}
