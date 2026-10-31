import "server-only";
import { refreshRequisitionStatus } from "@/modules/procurement/requisition-links";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal, toDecimal } from "@/lib/decimal";
import { accessibleScope, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import {
  assertActive,
  assertWarehousePermission,
  loadLocation,
  loadProductForPosting,
  loadWarehouse,
  toBase,
  todayFor,
  type WarehouseInfo,
} from "./context";
import { nextDocumentNumber, postDocument, type PostingLine } from "./posting";
import { isExpired } from "./rules";
import {
  cancelShipmentSchema,
  createShipmentSchema,
  receiveShipmentSchema,
  shipmentLineSchema,
} from "./schemas";

/**
 * Shipments between warehouses with a dispatch → receive gap (DECISIONS.md
 * ADR-026). Dispatching moves stock to IN_TRANSIT at the source (value stays
 * with the source); receiving moves it to AVAILABLE at the destination,
 * carrying its value, and writes off any shortage from IN_TRANSIT.
 */

export const SHIPMENT_PAGE_SIZE = 25;
const dec = (v: { toString(): string }) => new Decimal(v.toString());
const yearOf = (today: string) => Number(today.slice(0, 4));

/** An active warehouse of this organization; the sender need not see the destination's stock. */
async function loadDestination(tx: Tx, ctx: TenantContext, warehouseId: string) {
  const wh = await tx.warehouse.findFirst({
    where: { organizationId: ctx.organizationId, id: warehouseId },
    select: {
      id: true,
      code: true,
      name: true,
      branchId: true,
      archivedAt: true,
      branch: { select: { archivedAt: true, timeZone: true } },
    },
  });
  if (!wh) throw notFound("Warehouse");
  if (wh.archivedAt || wh.branch.archivedAt)
    throw businessRuleViolation("WAREHOUSE_ARCHIVED", "The warehouse is archived");
  return wh;
}

/** Lock the shipment row; visible to users who see stock at either end. */
async function lockShipment(tx: Tx, ctx: TenantContext, shipmentId: string) {
  await tx.$queryRaw`
    SELECT "id" FROM "stock_shipments"
    WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${shipmentId}::uuid
    FOR UPDATE`;
  const shipment = await tx.stockShipment.findFirst({
    where: { organizationId: ctx.organizationId, id: shipmentId },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      from: { select: { id: true, branchId: true } },
      to: { select: { id: true, branchId: true } },
    },
  });
  if (!shipment || !canSee(ctx, shipment)) throw notFound("Shipment");
  return shipment;
}

function canSee(
  ctx: TenantContext,
  s: { from: { id: string; branchId: string }; to: { id: string; branchId: string } },
) {
  const at = (w: { id: string; branchId: string }) =>
    hasPermission(ctx.grants, "inventory.view", { branchId: w.branchId, warehouseId: w.id });
  return at(s.from) || at(s.to);
}

function requireStatus(ok: boolean, status: string) {
  if (!ok)
    throw businessRuleViolation("SHIPMENT_STATUS", "Not possible in the shipment's status", {
      status,
    });
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  shipment: { id: string; number: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `shipment.${action}`,
    entityType: "shipment",
    entityId: shipment.id,
    changes: { number: shipment.number, ...changes },
  });
}

// ─── Draft ───

export async function createShipment(ctx: TenantContext, rawInput: unknown) {
  const parsed = createShipmentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  if (input.fromWarehouseId === input.toWarehouseId)
    throw businessRuleViolation("TRANSFER_SAME_PLACE", "Source and destination are the same", {
      field: "toWarehouseId",
    });
  return runIdempotent(ctx, { key: idempotencyKey, operation: "shipment.create", input }, (tx) =>
    createShipmentInTx(tx, ctx, input),
  );
}

/** Create a draft shipment inside the caller's transaction (also used for central kitchen fulfilment). */
export async function createShipmentInTx(
  tx: Tx,
  ctx: TenantContext,
  input: { fromWarehouseId: string; toWarehouseId: string; expectedOn?: string; note?: string },
) {
  const from = await loadWarehouse(tx, ctx, input.fromWarehouseId);
  assertWarehousePermission(ctx, "inventory.transfer", from);
  assertActive(from);
  const to = await loadDestination(tx, ctx, input.toWarehouseId);
  const number = await nextDocumentNumber(tx, ctx.organizationId, "SHP", yearOf(todayFor(from)));
  const shipment = await tx.stockShipment.create({
    data: {
      organizationId: ctx.organizationId,
      number,
      fromWarehouseId: from.id,
      toWarehouseId: to.id,
      expectedOn: input.expectedOn ? new Date(`${input.expectedOn}T00:00:00Z`) : null,
      note: input.note,
      createdByUserId: ctx.userId,
    },
    select: { id: true, number: true },
  });
  await audit(tx, ctx, shipment, "created", { from: from.code, to: to.code });
  return shipment;
}

/** Add usable stock of the source warehouse (one balance bucket) to a draft. */
export async function addShipmentLine(ctx: TenantContext, shipmentId: string, rawInput: unknown) {
  const parsed = shipmentLineSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, (tx) => addShipmentLineInTx(tx, ctx, shipmentId, input));
}

/** Add one balance bucket of the source to a draft, inside the caller's transaction. */
export async function addShipmentLineInTx(
  tx: Tx,
  ctx: TenantContext,
  shipmentId: string,
  input: { balanceId: string; quantity: string; uomId: string },
) {
  const shipment = await lockShipment(tx, ctx, shipmentId);
  requireStatus(shipment.status === "DRAFT", shipment.status);
  const from = await loadWarehouse(tx, ctx, shipment.fromWarehouseId);
  assertWarehousePermission(ctx, "inventory.transfer", from);
  const balance = await tx.stockBalance.findFirst({
    where: {
      organizationId: ctx.organizationId,
      id: input.balanceId,
      warehouseId: from.id,
      stockStatus: "AVAILABLE",
    },
    include: { lot: { select: { expiresOn: true, recallHold: true } } },
  });
  if (!balance) throw notFound("Stock");
  assertUsableLot(balance.lot, todayFor(from));
  const product = await loadProductForPosting(tx, ctx, balance.productId);
  const quantityBase = await toBase(tx, ctx, product, input.uomId, input.quantity);
  const available = dec(balance.onHandQuantity).minus(dec(balance.reservedQuantity));
  if (quantityBase.greaterThan(available))
    throw businessRuleViolation("INSUFFICIENT_STOCK", "Not enough available stock", {
      field: "quantity",
      available: available.toFixed(),
    });
  const lineNo = shipment.lines.reduce((m, l) => Math.max(m, l.lineNo), 0) + 1;
  const line = await tx.stockShipmentLine.create({
    data: {
      organizationId: ctx.organizationId,
      shipmentId: shipment.id,
      lineNo,
      productId: balance.productId,
      lotId: balance.lotId,
      fromWarehouseId: from.id,
      fromLocationId: balance.locationId,
      uomId: input.uomId,
      quantity: input.quantity,
      quantityBase: quantityBase.toFixed(),
    },
    select: { id: true },
  });
  await audit(tx, ctx, shipment, "line_added", {
    productId: balance.productId,
    quantity: quantityBase.toFixed(),
  });
  return line;
}

export async function removeShipmentLine(ctx: TenantContext, shipmentId: string, lineId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const shipment = await lockShipment(tx, ctx, shipmentId);
    requireStatus(shipment.status === "DRAFT", shipment.status);
    assertWarehousePermission(
      ctx,
      "inventory.transfer",
      await loadWarehouse(tx, ctx, shipment.fromWarehouseId),
    );
    const line = shipment.lines.find((l) => l.id === lineId);
    if (!line) throw notFound("Shipment line");
    await tx.stockShipmentLine.delete({ where: { id: line.id } });
    await audit(tx, ctx, shipment, "line_removed", { lineNo: line.lineNo });
  });
}

function assertUsableLot(
  lot: { expiresOn: Date | null; recallHold: boolean } | null,
  today: string,
) {
  if (!lot) return;
  if (lot.recallHold)
    throw businessRuleViolation("LOT_ON_RECALL_HOLD", "This lot is on recall hold");
  const expiresOn = lot.expiresOn?.toISOString().slice(0, 10) ?? null;
  if (isExpired(expiresOn, today))
    throw businessRuleViolation("LOT_EXPIRED", "This lot has expired", { expiresOn });
}

// ─── Dispatch, receive, cancel ───

/** Dispatch: every line moves AVAILABLE → IN_TRANSIT at the source, in one posting. */
export async function dispatchShipment(ctx: TenantContext, shipmentId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const shipment = await lockShipment(tx, ctx, shipmentId);
    requireStatus(shipment.status === "DRAFT", shipment.status);
    if (shipment.lines.length === 0)
      throw businessRuleViolation("SHIPMENT_HAS_NO_LINES", "Add at least one line first");
    const from = await loadWarehouse(tx, ctx, shipment.fromWarehouseId);
    assertWarehousePermission(ctx, "inventory.transfer", from);
    assertActive(from);
    await loadDestination(tx, ctx, shipment.toWarehouseId);
    const today = todayFor(from);
    const lines: PostingLine[] = [];
    for (const l of shipment.lines) {
      if (l.lotId) {
        const lot = await tx.inventoryLot.findFirstOrThrow({
          where: { organizationId: ctx.organizationId, id: l.lotId },
          select: { expiresOn: true, recallHold: true },
        });
        assertUsableLot(lot, today);
      }
      const common = {
        movementType: "STATUS_CHANGE" as const,
        warehouseId: from.id,
        locationId: l.fromLocationId,
        productId: l.productId,
        lotId: l.lotId,
        enteredUomId: l.uomId,
        sourceLineId: l.id,
        note: shipment.number,
      };
      const out = lines.length;
      lines.push(
        {
          ...common,
          stockStatus: "AVAILABLE",
          quantityDelta: dec(l.quantityBase).negated(),
          enteredQuantity: dec(l.quantity).negated(),
          postingKey: `shipment:${l.id}:dispatch:from`,
        },
        {
          ...common,
          stockStatus: "IN_TRANSIT",
          quantityDelta: dec(l.quantityBase),
          enteredQuantity: dec(l.quantity),
          postingKey: `shipment:${l.id}:dispatch:to`,
          costFromLine: out,
        },
      );
    }
    const posted = await postDocument(
      tx,
      ctx,
      {
        type: "DISPATCH",
        warehouseId: from.id,
        destinationWarehouseId: shipment.toWarehouseId,
        note: shipment.note ?? undefined,
      },
      lines,
      { year: yearOf(today), auditChanges: { shipment: shipment.number } },
    );
    await tx.stockShipment.update({
      where: { id: shipment.id },
      data: {
        status: "IN_TRANSIT",
        dispatchDocumentId: posted.documentId,
        dispatchedAt: new Date(),
        dispatchedByUserId: ctx.userId,
      },
    });
    await audit(tx, ctx, shipment, "dispatched", { document: posted.number });
    return { documentNumber: posted.number };
  });
}

/**
 * Receive at the destination. Per line, the received quantity (at most what
 * was dispatched) moves to AVAILABLE there, valued at what it left with; any
 * shortfall is written off from IN_TRANSIT with the given reason.
 */
export async function receiveShipment(ctx: TenantContext, shipmentId: string, rawInput: unknown) {
  const parsed = receiveShipmentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "shipment.receive", input: { shipmentId, ...input } },
    async (tx) => {
      const shipment = await lockShipment(tx, ctx, shipmentId);
      requireStatus(shipment.status === "IN_TRANSIT", shipment.status);
      const to = await loadWarehouse(tx, ctx, shipment.toWarehouseId);
      assertWarehousePermission(ctx, "inventory.transfer", to);
      assertActive(to);
      const toLocation = await loadLocation(tx, ctx, to.id, input.toLocationId, true);
      const byLine = new Map(input.lines.map((l, i) => [l.lineId, { ...l, index: i }]));
      const recalled = new Set(
        (
          await tx.inventoryLot.findMany({
            where: {
              organizationId: ctx.organizationId,
              id: { in: shipment.lines.flatMap((l) => (l.lotId ? [l.lotId] : [])) },
              recallHold: true,
            },
            select: { id: true },
          })
        ).map((l) => l.id),
      );
      const lines: PostingLine[] = [];
      const updates: Array<{ id: string; received: Decimal; reason: string | null }> = [];
      for (const l of shipment.lines) {
        const entry = byLine.get(l.id);
        if (!entry)
          throw businessRuleViolation(
            "SHIPMENT_LINE_MISSING",
            "Enter the received quantity of every line",
          );
        const product = await loadProductForPosting(tx, ctx, l.productId);
        const receivedEntered = toDecimal(entry.receivedQuantity);
        const received = receivedEntered.isZero()
          ? new Decimal(0)
          : await toBase(tx, ctx, product, l.uomId, entry.receivedQuantity);
        const dispatched = dec(l.quantityBase);
        if (received.greaterThan(dispatched))
          throw businessRuleViolation("SHIPMENT_OVER_RECEIPT", "More than was dispatched", {
            field: `lines.${entry.index}.receivedQuantity`,
            maximum: dec(l.quantity).toFixed(),
          });
        const shortage = dispatched.minus(received);
        if (shortage.gt(0) && !entry.shortageReason)
          throw businessRuleViolation(
            "SHORTAGE_REASON_REQUIRED",
            "Give a reason for the shortage",
            {
              field: `lines.${entry.index}.shortageReason`,
            },
          );
        const transit = {
          productId: l.productId,
          lotId: l.lotId,
          enteredUomId: l.uomId,
          sourceLineId: l.id,
          note: shipment.number,
        };
        if (received.gt(0)) {
          const out = lines.length;
          lines.push(
            {
              ...transit,
              movementType: "TRANSFER_OUT",
              warehouseId: shipment.fromWarehouseId,
              locationId: l.fromLocationId,
              stockStatus: "IN_TRANSIT",
              quantityDelta: received.negated(),
              enteredQuantity: receivedEntered.negated(),
              postingKey: `shipment:${l.id}:receive:out`,
            },
            {
              ...transit,
              movementType: "TRANSFER_IN",
              warehouseId: to.id,
              locationId: toLocation,
              // A lot recalled while on the way arrives on hold (ADR-034).
              stockStatus: recalled.has(l.lotId ?? "") ? "ON_HOLD" : "AVAILABLE",
              quantityDelta: received,
              enteredQuantity: receivedEntered,
              postingKey: `shipment:${l.id}:receive:in`,
              costFromLine: out,
            },
          );
        }
        if (shortage.gt(0)) {
          lines.push({
            ...transit,
            movementType: "WRITE_OFF",
            warehouseId: shipment.fromWarehouseId,
            locationId: l.fromLocationId,
            stockStatus: "IN_TRANSIT",
            quantityDelta: shortage.negated(),
            // Entered in the base unit: the shortfall rarely is a whole line unit.
            enteredQuantity: shortage.negated(),
            enteredUomId: product.baseUomId,
            postingKey: `shipment:${l.id}:receive:shortage`,
            reasonCode: entry.shortageReason,
          });
        }
        updates.push({
          id: l.id,
          received,
          reason: shortage.gt(0) ? (entry.shortageReason ?? null) : null,
        });
      }
      const posted = await postDocument(
        tx,
        ctx,
        {
          type: "TRANSIT_RECEIPT",
          warehouseId: shipment.fromWarehouseId,
          destinationWarehouseId: to.id,
          note: shipment.note ?? undefined,
        },
        lines,
        { year: yearOf(todayFor(to)), auditChanges: { shipment: shipment.number } },
      );
      for (const u of updates)
        await tx.stockShipmentLine.update({
          where: { id: u.id },
          data: { receivedQuantityBase: u.received.toFixed(), shortageReason: u.reason },
        });
      await tx.stockShipment.update({
        where: { id: shipment.id },
        data: {
          status: "RECEIVED",
          toLocationId: toLocation,
          receiptDocumentId: posted.documentId,
          receivedAt: new Date(),
          receivedByUserId: ctx.userId,
        },
      });
      await audit(tx, ctx, shipment, "received", {
        document: posted.number,
        shortages: updates.filter((u) => u.reason).length,
      });
      return { documentNumber: posted.number };
    },
  );
}

/**
 * Cancel a draft, or recall a shipment still in transit: its stock returns
 * to AVAILABLE at the source.
 */
export async function cancelShipment(ctx: TenantContext, shipmentId: string, rawInput: unknown) {
  const parsed = cancelShipmentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const shipment = await lockShipment(tx, ctx, shipmentId);
    requireStatus(shipment.status === "DRAFT" || shipment.status === "IN_TRANSIT", shipment.status);
    const from = await loadWarehouse(tx, ctx, shipment.fromWarehouseId);
    assertWarehousePermission(ctx, "inventory.transfer", from);
    // Branch requests this shipment was meant to fulfil become open again (ADR-046).
    const released = await tx.purchaseRequisitionLine.findMany({
      where: { organizationId: ctx.organizationId, shipmentId: shipment.id },
      select: { requisitionId: true },
    });
    if (released.length > 0) {
      await tx.purchaseRequisitionLine.updateMany({
        where: { organizationId: ctx.organizationId, shipmentId: shipment.id },
        data: { shipmentId: null, orderedAt: null },
      });
      for (const id of [...new Set(released.map((r) => r.requisitionId))].sort())
        await refreshRequisitionStatus(tx, ctx, id);
    }
    let cancelDocumentId: string | null = null;
    if (shipment.status === "IN_TRANSIT") {
      const lines: PostingLine[] = [];
      for (const l of shipment.lines) {
        const common = {
          movementType: "STATUS_CHANGE" as const,
          warehouseId: from.id,
          locationId: l.fromLocationId,
          productId: l.productId,
          lotId: l.lotId,
          enteredUomId: l.uomId,
          sourceLineId: l.id,
          note: parsed.data.reason,
        };
        const out = lines.length;
        lines.push(
          {
            ...common,
            stockStatus: "IN_TRANSIT",
            quantityDelta: dec(l.quantityBase).negated(),
            enteredQuantity: dec(l.quantity).negated(),
            postingKey: `shipment:${l.id}:cancel:from`,
          },
          {
            ...common,
            stockStatus: "AVAILABLE",
            quantityDelta: dec(l.quantityBase),
            enteredQuantity: dec(l.quantity),
            postingKey: `shipment:${l.id}:cancel:to`,
            costFromLine: out,
          },
        );
      }
      const posted = await postDocument(
        tx,
        ctx,
        { type: "DISPATCH", warehouseId: from.id, note: parsed.data.reason },
        lines,
        {
          year: yearOf(todayFor(from)),
          auditChanges: { shipment: shipment.number, cancelled: true },
        },
      );
      cancelDocumentId = posted.documentId;
    }
    await tx.stockShipment.update({
      where: { id: shipment.id },
      data: {
        status: "CANCELLED",
        cancelDocumentId,
        cancelledAt: new Date(),
        cancelledByUserId: ctx.userId,
      },
    });
    await audit(tx, ctx, shipment, "cancelled", { reason: parsed.data.reason });
  });
}

// ─── Queries ───

function visibleShipments(ctx: TenantContext): Prisma.StockShipmentWhereInput {
  const scope = accessibleScope(ctx.grants, "inventory.view");
  if (scope.all) return {};
  const at: Prisma.WarehouseWhereInput = {
    OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }],
  };
  return { OR: [{ from: at }, { to: at }] };
}

export async function listShipments(
  ctx: TenantContext,
  filters: { status?: "DRAFT" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED"; page?: number } = {},
) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.StockShipmentWhereInput = {
    organizationId: ctx.organizationId,
    ...visibleShipments(ctx),
    ...(filters.status ? { status: filters.status } : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.stockShipment.count({ where }),
      tx.stockShipment.findMany({
        where,
        select: {
          id: true,
          number: true,
          status: true,
          expectedOn: true,
          dispatchedAt: true,
          receivedAt: true,
          createdAt: true,
          from: { select: { code: true, name: true } },
          to: { select: { code: true, name: true } },
          _count: { select: { lines: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * SHIPMENT_PAGE_SIZE,
        take: SHIPMENT_PAGE_SIZE,
      }),
    ]);
    return { items, total, page, pageCount: Math.max(1, Math.ceil(total / SHIPMENT_PAGE_SIZE)) };
  });
}

export async function getShipment(ctx: TenantContext, shipmentId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const shipment = await tx.stockShipment.findFirst({
      where: { organizationId: ctx.organizationId, id: shipmentId },
      include: {
        from: { select: { id: true, code: true, name: true, branchId: true } },
        to: { select: { id: true, code: true, name: true, branchId: true } },
        toLocation: { select: { code: true } },
        dispatchDoc: { select: { id: true, number: true } },
        receiptDoc: { select: { id: true, number: true } },
        cancelDoc: { select: { id: true, number: true } },
        lines: {
          orderBy: { lineNo: "asc" },
          include: {
            product: {
              select: {
                id: true,
                sku: true,
                nameEn: true,
                nameAr: true,
                baseUom: { select: { code: true } },
              },
            },
            lot: { select: { lotCode: true, expiresOn: true } },
            fromLocation: { select: { code: true } },
            uom: { select: { code: true } },
          },
        },
      },
    });
    if (!shipment || !canSee(ctx, shipment)) throw notFound("Shipment");
    const on = (w: { id: string; branchId: string }) =>
      hasPermission(ctx.grants, "inventory.transfer", { branchId: w.branchId, warehouseId: w.id });
    return {
      ...shipment,
      lines: shipment.lines.map((l) => ({
        ...l,
        // Received quantity in the line's unit, for display.
        receivedQuantity:
          l.receivedQuantityBase === null
            ? null
            : dec(l.receivedQuantityBase)
                .times(dec(l.quantity))
                .dividedBy(dec(l.quantityBase))
                .toDecimalPlaces(6),
      })),
      can: {
        edit: shipment.status === "DRAFT" && on(shipment.from),
        dispatch: shipment.status === "DRAFT" && shipment.lines.length > 0 && on(shipment.from),
        receive: shipment.status === "IN_TRANSIT" && on(shipment.to),
        cancel:
          (shipment.status === "DRAFT" || shipment.status === "IN_TRANSIT") && on(shipment.from),
      },
    };
  });
}

/** Usable stock of a warehouse for the "add line" picker (AVAILABLE, unexpired, not recalled). */
export async function shipmentStockOptions(ctx: TenantContext, warehouse: WarehouseInfo) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const today = todayFor(warehouse);
    const rows = await tx.stockBalance.findMany({
      where: {
        organizationId: ctx.organizationId,
        warehouseId: warehouse.id,
        stockStatus: "AVAILABLE",
        onHandQuantity: { gt: 0 },
      },
      include: {
        product: {
          select: { sku: true, nameEn: true, nameAr: true, baseUom: { select: { code: true } } },
        },
        lot: { select: { lotCode: true, expiresOn: true, recallHold: true } },
        location: { select: { code: true } },
      },
      orderBy: [
        { product: { sku: "asc" } },
        { lot: { expiresOn: { sort: "asc", nulls: "last" } } },
      ],
      take: 2000,
    });
    return rows.filter(
      (r) =>
        !r.lot ||
        (!r.lot.recallHold &&
          !isExpired(r.lot.expiresOn?.toISOString().slice(0, 10) ?? null, today)),
    );
  });
}

/** Warehouse info (for pickers) when the user may dispatch from it. */
export async function shipmentSource(ctx: TenantContext, shipmentId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await tx.stockShipment.findFirst({
      where: { organizationId: ctx.organizationId, id: shipmentId },
      select: { fromWarehouseId: true },
    });
    if (!s) throw notFound("Shipment");
    return loadWarehouse(tx, ctx, s.fromWarehouseId);
  });
}

/** All active warehouses (code and name only), as shipment destinations. */
export async function destinationOptions(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.warehouse.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null, branch: { archivedAt: null } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  );
}
