import "server-only";
import { Decimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { notFound } from "@/server/errors";
import { summarizeTrace } from "./rules";

/**
 * Lot traceability (DECISIONS.md ADR-033), built only from recorded facts:
 * ledger entries, goods receipt lines and shipments. Organization-wide;
 * needs `traceability.view`.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());

export async function searchLots(ctx: TenantContext, q: string) {
  assertPermission(ctx.grants, "traceability.view");
  const term = q.trim();
  if (term.length === 0) return [];
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.inventoryLot.findMany({
      where: {
        organizationId: ctx.organizationId,
        OR: [
          { lotCode: { contains: term, mode: "insensitive" } },
          { product: { sku: { contains: term, mode: "insensitive" } } },
          { product: { nameEn: { contains: term, mode: "insensitive" } } },
        ],
      },
      select: {
        id: true,
        lotCode: true,
        expiresOn: true,
        recallHold: true,
        firstReceivedAt: true,
        product: { select: { id: true, sku: true, nameEn: true, nameAr: true } },
      },
      orderBy: [{ firstReceivedAt: "desc" }],
      take: 50,
    }),
  );
}

/** Lots received from a supplier (optionally of one product), for recall scoping. */
export async function lotsFromSupplier(ctx: TenantContext, supplierId: string, productId?: string) {
  assertPermission(ctx.grants, "traceability.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const lines = await tx.goodsReceiptLine.findMany({
      where: {
        organizationId: ctx.organizationId,
        lotId: { not: null },
        receipt: { supplierId, status: "POSTED" },
        ...(productId ? { productId } : {}),
      },
      select: { lotId: true },
      distinct: ["lotId"],
    });
    return lines.map((l) => l.lotId as string);
  });
}

export async function lotStock(tx: Tx, ctx: TenantContext, lotIds: string[]) {
  return tx.stockBalance.findMany({
    where: { organizationId: ctx.organizationId, lotId: { in: lotIds }, onHandQuantity: { gt: 0 } },
    select: {
      lotId: true,
      productId: true,
      warehouseId: true,
      locationId: true,
      stockStatus: true,
      onHandQuantity: true,
      warehouse: { select: { code: true, name: true } },
      location: { select: { code: true } },
    },
    orderBy: [{ warehouseId: "asc" }, { stockStatus: "asc" }],
  });
}

export async function traceLot(ctx: TenantContext, lotId: string) {
  assertPermission(ctx.grants, "traceability.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const lot = await tx.inventoryLot.findFirst({
      where: { organizationId: ctx.organizationId, id: lotId },
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            nameEn: true,
            nameAr: true,
            lotTracking: true,
            baseUom: { select: { code: true } },
          },
        },
      },
    });
    if (!lot) throw notFound("Lot");
    const entries = await tx.inventoryLedgerEntry.findMany({
      where: { organizationId: ctx.organizationId, lotId: lot.id },
      select: {
        id: true,
        movementType: true,
        warehouseId: true,
        locationId: true,
        stockStatus: true,
        quantityDelta: true,
        occurredAt: true,
        reversesEntryId: true,
        reasonCode: true,
        document: { select: { id: true, number: true, type: true } },
        warehouse: { select: { code: true } },
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: 2000,
    });
    const warehouseIds = [...new Set(entries.map((e) => e.warehouseId))];
    const firstArrival =
      entries.find((e) => dec(e.quantityDelta).gt(0))?.occurredAt ?? lot.firstReceivedAt;
    const unlotted = await tx.inventoryLedgerEntry.findMany({
      where: {
        organizationId: ctx.organizationId,
        productId: lot.productId,
        lotId: null,
        warehouseId: { in: warehouseIds },
        quantityDelta: { lt: 0 },
        movementType: {
          in: ["WRITE_OFF", "ADJUSTMENT", "COUNT_ADJUSTMENT", "CONSUMPTION", "RETURN_TO_SUPPLIER"],
        },
        occurredAt: { gte: firstArrival },
      },
      select: {
        id: true,
        movementType: true,
        warehouseId: true,
        quantityDelta: true,
        occurredAt: true,
        reversesEntryId: true,
        document: { select: { id: true, number: true } },
        warehouse: { select: { code: true } },
      },
      orderBy: { occurredAt: "asc" },
      take: 200,
    });
    const summary = summarizeTrace(
      entries.map((e) => ({ ...e, quantityDelta: dec(e.quantityDelta) })),
      unlotted.map((e) => ({ ...e, quantityDelta: dec(e.quantityDelta) })),
    );
    const receipts = await tx.goodsReceiptLine.findMany({
      where: { organizationId: ctx.organizationId, lotId: lot.id },
      select: {
        id: true,
        acceptedQuantity: true,
        rejectedQuantity: true,
        temperatureCelsius: true,
        uom: { select: { code: true } },
        receipt: {
          select: {
            id: true,
            number: true,
            status: true,
            receivedAt: true,
            deliveryNoteRef: true,
            supplier: {
              select: { id: true, code: true, name: true, nameAr: true, phone: true, email: true },
            },
            purchaseOrder: { select: { id: true, number: true } },
            warehouse: { select: { code: true } },
          },
        },
      },
      orderBy: { receipt: { receivedAt: "asc" } },
    });
    const shipments = await tx.stockShipmentLine.findMany({
      where: { organizationId: ctx.organizationId, lotId: lot.id },
      select: {
        quantityBase: true,
        receivedQuantityBase: true,
        shipment: {
          select: {
            id: true,
            number: true,
            status: true,
            dispatchedAt: true,
            receivedAt: true,
            from: { select: { code: true } },
            to: { select: { code: true } },
          },
        },
      },
    });
    const recalls = await tx.recallLot.findMany({
      where: { organizationId: ctx.organizationId, lotId: lot.id },
      select: { recall: { select: { id: true, number: true, status: true, title: true } } },
    });
    const byId = new Map(entries.map((e) => [e.id, e]));
    const unlottedById = new Map(unlotted.map((e) => [e.id, e]));
    return {
      lot,
      entries,
      origins: summary.origins.map((id) => byId.get(id)!),
      exits: summary.exits.map((id) => byId.get(id)!),
      received: summary.received,
      exited: summary.exited,
      onHand: summary.onHand,
      gaps: summary.gaps.map((g) => ({
        ...g,
        entry: byId.get(g.entryId) ?? unlottedById.get(g.entryId)!,
      })),
      receipts,
      shipments,
      stock: await lotStock(tx, ctx, [lot.id]),
      recalls: recalls.map((r) => r.recall),
    };
  });
}
