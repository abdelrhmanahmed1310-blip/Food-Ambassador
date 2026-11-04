import "server-only";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { deliverSalesOrderInTx } from "@/modules/b2b/service";
import { postPickMovesInTx } from "@/modules/inventory/operations";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { allocatePick, walkOrder, type PickCandidate } from "./rules";

/**
 * Pick lists and waves (DECISIONS.md ADR-102). A pick list plans, for a
 * confirmed sales order, which lot to take from which place — first-expiring
 * stock first, never from quarantine or dispatch areas, net of what other
 * open pick lists already hold. Confirming the pick moves the picked stock in
 * the ledger to the warehouse's dispatch location for the product's
 * temperature; delivering the list delivers exactly that stock. A wave plans
 * several orders of one warehouse together with one walk-ordered pick sheet.
 * Planning and picking need `inventory.transfer` at the warehouse;
 * delivering needs `b2b.manage`.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

const confirmSchema = z.object({
  lines: z
    .array(
      z.object({
        id: uuidSchema,
        pickedQuantity: decimalString({ maxScale: 6, min: "0" }),
        shortReason: optionalText(500),
      }),
    )
    .min(1)
    .max(500),
});
const waveSchema = z.object({
  warehouseId: uuidSchema,
  orderIds: z.array(uuidSchema).min(1, { error: "nothingSelected" }).max(100),
  note: optionalText(500),
});
const cancelSchema = z.object({ reason: requiredText(500) });

async function loadWarehouseFor(tx: Tx, ctx: TenantContext, warehouseId: string) {
  const wh = await tx.warehouse.findFirst({
    where: { organizationId: ctx.organizationId, id: warehouseId },
    select: {
      id: true,
      code: true,
      name: true,
      branchId: true,
      archivedAt: true,
      branch: { select: { timeZone: true } },
    },
  });
  if (
    !wh ||
    !hasPermission(ctx.grants, "inventory.view", { branchId: wh.branchId, warehouseId: wh.id })
  )
    throw notFound("Warehouse");
  return wh;
}

const scopeOf = (wh: { id: string; branchId: string }) => ({
  branchId: wh.branchId,
  warehouseId: wh.id,
});

/** Plan one pick list inside a planning transaction (warehouse already locked). */
async function planInTx(
  tx: Tx,
  ctx: TenantContext,
  wh: Awaited<ReturnType<typeof loadWarehouseFor>>,
  orderId: string,
  waveId: string | null,
) {
  const order = await tx.salesOrder.findFirst({
    where: { organizationId: ctx.organizationId, id: orderId },
    include: {
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          product: { select: { id: true, sku: true, storageRequirement: true } },
        },
      },
    },
  });
  if (!order) throw notFound("Sales order");
  if (order.warehouseId !== wh.id)
    throw businessRuleViolation("PICK_WRONG_WAREHOUSE", "The order ships from another warehouse", {
      number: order.number,
    });
  if (!["CONFIRMED", "PARTIALLY_DELIVERED"].includes(order.status))
    throw businessRuleViolation("SALES_ORDER_NOT_OPEN", "Only confirmed orders can be picked", {
      status: order.status,
    });
  const active = await tx.pickList.findFirst({
    where: {
      organizationId: ctx.organizationId,
      salesOrderId: order.id,
      status: { in: ["PLANNED", "PICKED"] },
    },
    select: { number: true },
  });
  if (active)
    throw businessRuleViolation("PICK_LIST_OPEN", "The order already has an open pick list", {
      number: active.number,
    });
  const open = order.lines
    .map((l) => ({ line: l, open: dec(l.quantityBase).minus(dec(l.deliveredQuantityBase)) }))
    .filter((o) => o.open.gt(0));
  if (open.length === 0)
    throw businessRuleViolation("NOTHING_TO_DELIVER", "Nothing is open to deliver");

  const locations = await tx.storageLocation.findMany({
    where: { organizationId: ctx.organizationId, warehouseId: wh.id },
    select: { id: true, code: true, zone: true, temperatureZone: true, archivedAt: true },
    orderBy: { code: "asc" },
  });
  const staging = (temperature: string) =>
    locations.find(
      (l) => l.zone === "DISPATCH" && !l.archivedAt && l.temperatureZone === temperature,
    );
  const productIds = [...new Set(open.map((o) => o.line.productId))];
  const balances = await tx.stockBalance.findMany({
    where: {
      organizationId: ctx.organizationId,
      warehouseId: wh.id,
      productId: { in: productIds },
      stockStatus: "AVAILABLE",
      onHandQuantity: { gt: 0 },
    },
    select: {
      id: true,
      productId: true,
      locationId: true,
      lotId: true,
      onHandQuantity: true,
      lot: {
        select: { expiresOn: true, bestBeforeOn: true, recallHold: true, firstReceivedAt: true },
      },
    },
  });
  // What open (planned) pick lists already hold, per place and lot.
  const held = await tx.pickListLine.groupBy({
    by: ["productId", "locationId", "lotId"],
    where: {
      organizationId: ctx.organizationId,
      productId: { in: productIds },
      pickList: { warehouseId: wh.id, status: "PLANNED" },
    },
    _sum: { plannedQuantity: true },
  });
  const heldAt = (productId: string, locationId: string | null, lotId: string | null) =>
    dec(
      held.find(
        (h) => h.productId === productId && h.locationId === locationId && h.lotId === lotId,
      )?._sum.plannedQuantity ?? 0,
    );
  // Taken by earlier lines of this same plan.
  const taken = new Map<string, Decimal>();
  const today = businessDate(wh.branch.timeZone ?? ctx.timeZone);
  const lines: Array<{
    orderLineId: string;
    productId: string;
    lotId: string | null;
    locationId: string | null;
    stagingLocationId: string;
    plannedQuantity: Decimal;
  }> = [];
  const shortages: Array<{ sku: string; short: string }> = [];
  for (const { line, open: wanted } of open) {
    const stage = staging(line.product.storageRequirement);
    if (!stage)
      throw businessRuleViolation(
        "PICK_NO_DISPATCH_LOCATION",
        "The warehouse has no dispatch location at this temperature",
        { temperature: line.product.storageRequirement },
      );
    const candidates: PickCandidate[] = balances
      .filter((b) => b.productId === line.productId)
      .map((b) => {
        const loc = b.locationId ? locations.find((l) => l.id === b.locationId) : undefined;
        return {
          key: b.id,
          locationId: b.locationId,
          locationCode: loc?.code ?? null,
          zone: loc ? loc.zone : null,
          lotId: b.lotId,
          expiresOn: day(b.lot?.expiresOn),
          bestBeforeOn: day(b.lot?.bestBeforeOn),
          firstReceivedAt: b.lot?.firstReceivedAt ?? new Date(0),
          recallHold: b.lot?.recallHold ?? false,
          available: dec(b.onHandQuantity)
            .minus(heldAt(b.productId, b.locationId, b.lotId))
            .minus(taken.get(b.id) ?? new Decimal(0)),
        };
      });
    const plan = allocatePick(candidates, wanted, today);
    for (const p of plan.picks) {
      taken.set(p.candidate.key, (taken.get(p.candidate.key) ?? new Decimal(0)).plus(p.quantity));
      lines.push({
        orderLineId: line.id,
        productId: line.productId,
        lotId: p.candidate.lotId,
        locationId: p.candidate.locationId,
        stagingLocationId: stage.id,
        plannedQuantity: p.quantity,
      });
    }
    if (plan.shortfall.gt(0))
      shortages.push({ sku: line.product.sku, short: plan.shortfall.toFixed() });
  }
  if (lines.length === 0)
    throw businessRuleViolation("PICK_NOTHING_AVAILABLE", "No usable stock to pick", {
      number: order.number,
    });
  const year = Number(today.slice(0, 4));
  const number = await nextDocumentNumber(tx, ctx.organizationId, "PCK", year);
  const list = await tx.pickList.create({
    data: {
      organizationId: ctx.organizationId,
      number,
      warehouseId: wh.id,
      salesOrderId: order.id,
      waveId,
      createdByUserId: ctx.userId,
    },
    select: { id: true, number: true },
  });
  await tx.pickListLine.createMany({
    data: lines.map((l, i) => ({
      organizationId: ctx.organizationId,
      pickListId: list.id,
      sequence: i + 1,
      ...l,
      plannedQuantity: l.plannedQuantity.toFixed(),
    })),
  });
  await recordAudit(tx, actorOf(ctx), {
    action: "pick_list.planned",
    entityType: "pick_list",
    entityId: list.id,
    changes: { number, order: order.number, lines: lines.length, shortages },
  });
  return { ...list, shortages };
}

async function lockPlanning(tx: Tx, ctx: TenantContext, warehouseId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pick-planning:${ctx.organizationId}:${warehouseId}`}))`;
}

/** Plan a pick list for one confirmed sales order. */
export async function createPickList(ctx: TenantContext, salesOrderId: string) {
  if (!isUuid(salesOrderId)) throw notFound("Sales order");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const order = await tx.salesOrder.findFirst({
      where: { organizationId: ctx.organizationId, id: salesOrderId },
      select: { warehouseId: true },
    });
    if (!order) throw notFound("Sales order");
    const wh = await loadWarehouseFor(tx, ctx, order.warehouseId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    await lockPlanning(tx, ctx, wh.id);
    return planInTx(tx, ctx, wh, salesOrderId, null);
  });
}

/** Plan several orders of one warehouse together; all or nothing. */
export async function createWave(ctx: TenantContext, rawInput: unknown) {
  const parsed = waveSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wh = await loadWarehouseFor(tx, ctx, input.warehouseId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    await lockPlanning(tx, ctx, wh.id);
    const today = businessDate(wh.branch.timeZone ?? ctx.timeZone);
    const number = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      "WAV",
      Number(today.slice(0, 4)),
    );
    const wave = await tx.pickWave.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        warehouseId: wh.id,
        note: input.note ?? null,
        createdByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    const lists = [];
    for (const orderId of [...new Set(input.orderIds)])
      lists.push(await planInTx(tx, ctx, wh, orderId, wave.id));
    await recordAudit(tx, actorOf(ctx), {
      action: "pick_wave.created",
      entityType: "pick_wave",
      entityId: wave.id,
      changes: { number, lists: lists.map((l) => l.number) },
    });
    return { ...wave, lists };
  });
}

async function lockList(tx: Tx, ctx: TenantContext, pickListId: string) {
  if (!isUuid(pickListId)) throw notFound("Pick list");
  const found = await tx.pickList.findFirst({
    where: { organizationId: ctx.organizationId, id: pickListId },
    select: { id: true },
  });
  if (!found) throw notFound("Pick list");
  await tx.$executeRaw`SELECT 1 FROM "pick_lists" WHERE "id" = ${pickListId}::uuid FOR UPDATE`;
  const list = await tx.pickList.findFirstOrThrow({
    where: { id: pickListId },
    include: {
      lines: {
        orderBy: { sequence: "asc" },
        include: { product: { select: { baseUomId: true } } },
      },
      salesOrder: { select: { id: true, number: true } },
    },
  });
  const wh = await loadWarehouseFor(tx, ctx, list.warehouseId);
  return { list, wh };
}

function requireStatus(status: string, allowed: string[]) {
  if (!allowed.includes(status))
    throw businessRuleViolation("PICK_LIST_STATUS", "Not possible in the pick list's status", {
      status,
    });
}

/** Record what was picked and move it to the dispatch locations. */
export async function confirmPick(ctx: TenantContext, pickListId: string, rawInput: unknown) {
  const parsed = confirmSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const given = new Map(parsed.data.lines.map((l) => [l.id, l]));
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { list, wh } = await lockList(tx, ctx, pickListId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    requireStatus(list.status, ["PLANNED"]);
    if (given.size !== list.lines.length || list.lines.some((l) => !given.has(l.id)))
      throw businessRuleViolation("PICK_LINES_MISSING", "Enter what was picked on every line");
    const moves = [];
    for (const l of list.lines) {
      const g = given.get(l.id)!;
      const picked = new Decimal(g.pickedQuantity);
      if (picked.gt(dec(l.plannedQuantity)))
        throw businessRuleViolation("PICK_MORE_THAN_PLANNED", "More than planned", {
          sequence: l.sequence,
          planned: dec(l.plannedQuantity).toFixed(),
        });
      if (picked.lt(dec(l.plannedQuantity)) && !g.shortReason)
        throw businessRuleViolation("PICK_SHORT_REASON_REQUIRED", "Say why less was picked", {
          sequence: l.sequence,
        });
      await tx.pickListLine.update({
        where: { id: l.id },
        data: {
          pickedQuantity: picked.toFixed(),
          shortReason: picked.lt(dec(l.plannedQuantity)) ? (g.shortReason ?? null) : null,
        },
      });
      if (picked.gt(0))
        moves.push({
          productId: l.productId,
          lotId: l.lotId,
          fromLocationId: l.locationId,
          toLocationId: l.stagingLocationId,
          quantity: picked,
        });
    }
    if (moves.length === 0)
      throw businessRuleViolation("NOTHING_PICKED", "Nothing was picked; cancel the list instead");
    const doc = await postPickMovesInTx(tx, ctx, {
      warehouseId: wh.id,
      moves,
      note: `Pick ${list.number} for ${list.salesOrder.number}`,
    });
    await tx.pickList.update({
      where: { id: list.id },
      data: {
        status: "PICKED",
        pickedAt: new Date(),
        pickedByUserId: ctx.userId,
        pickDocumentId: doc.documentId,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "pick_list.picked",
      entityType: "pick_list",
      entityId: list.id,
      changes: { number: list.number, document: doc.number },
    });
    return { document: doc };
  });
}

/** Deliver exactly what was picked, from the dispatch locations. */
export async function deliverPickList(ctx: TenantContext, pickListId: string) {
  assertPermission(ctx.grants, "b2b.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { list } = await lockList(tx, ctx, pickListId);
    requireStatus(list.status, ["PICKED"]);
    const delivery = await deliverSalesOrderInTx(
      tx,
      ctx,
      list.salesOrderId,
      [],
      list.lines
        .filter((l) => dec(l.pickedQuantity ?? 0).gt(0))
        .map((l) => ({
          orderLineId: l.orderLineId,
          productId: l.productId,
          lotId: l.lotId,
          locationId: l.stagingLocationId,
          baseUomId: l.product.baseUomId,
          quantity: dec(l.pickedQuantity ?? 0),
        })),
    );
    await tx.pickList.update({
      where: { id: list.id },
      data: { status: "DELIVERED", deliveryId: delivery.id },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "pick_list.delivered",
      entityType: "pick_list",
      entityId: list.id,
      changes: { number: list.number, delivery: delivery.number },
    });
    return delivery;
  });
}

/** Drop a list: a planned one releases its hold; a picked one moves the stock back. */
export async function cancelPickList(ctx: TenantContext, pickListId: string, rawInput: unknown) {
  const parsed = cancelSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { list, wh } = await lockList(tx, ctx, pickListId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    requireStatus(list.status, ["PLANNED", "PICKED"]);
    let returnDocumentId: string | null = null;
    if (list.status === "PICKED") {
      // Picked stock goes back where it was taken from.
      const doc = await postPickMovesInTx(tx, ctx, {
        warehouseId: wh.id,
        moves: list.lines
          .filter((l) => dec(l.pickedQuantity ?? 0).gt(0))
          .map((l) => ({
            productId: l.productId,
            lotId: l.lotId,
            fromLocationId: l.stagingLocationId,
            toLocationId: l.locationId,
            quantity: dec(l.pickedQuantity ?? 0),
          })),
        note: `Pick ${list.number} cancelled: ${parsed.data.reason}`,
      });
      returnDocumentId = doc.documentId;
    }
    await tx.pickList.update({
      where: { id: list.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: parsed.data.reason,
        returnDocumentId,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "pick_list.cancelled",
      entityType: "pick_list",
      entityId: list.id,
      changes: { number: list.number, reason: parsed.data.reason },
    });
  });
}

const listInclude = {
  salesOrder: {
    select: { id: true, number: true, customer: { select: { code: true, name: true } } },
  },
  warehouse: { select: { id: true, code: true, name: true, branchId: true } },
  wave: { select: { id: true, number: true } },
  _count: { select: { lines: true } },
} as const;

export async function listPickLists(ctx: TenantContext, filters: { status?: "open" | "all" } = {}) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const lists = await tx.pickList.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(filters.status === "all" ? {} : { status: { in: ["PLANNED", "PICKED"] } }),
      },
      include: listInclude,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return lists.filter((l) =>
      hasPermission(ctx.grants, "inventory.view", {
        branchId: l.warehouse.branchId,
        warehouseId: l.warehouseId,
      }),
    );
  });
}

const lineInclude = {
  product: {
    select: {
      sku: true,
      nameEn: true,
      nameAr: true,
      storageRequirement: true,
      baseUom: { select: { code: true } },
    },
  },
  lot: { select: { lotCode: true, expiresOn: true } },
  location: { select: { code: true, name: true } },
  staging: { select: { code: true, name: true } },
  orderLine: { select: { lineNo: true } },
} as const;

export async function getPickList(ctx: TenantContext, pickListId: string) {
  if (!isUuid(pickListId)) throw notFound("Pick list");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const list = await tx.pickList.findFirst({
      where: { organizationId: ctx.organizationId, id: pickListId },
      include: {
        ...listInclude,
        lines: { include: lineInclude, orderBy: { sequence: "asc" } },
        pickDocument: { select: { id: true, number: true } },
        returnDocument: { select: { id: true, number: true } },
        delivery: { select: { id: true, number: true } },
      },
    });
    if (!list) throw notFound("Pick list");
    const wh = await loadWarehouseFor(tx, ctx, list.warehouseId);
    return {
      ...list,
      branchId: wh.branchId,
      walk: walkOrder(
        list.lines.map((l) => ({
          ...l,
          locationCode: l.location?.code ?? null,
          sku: l.product.sku,
        })),
      ),
      canPick: hasPermission(ctx.grants, "inventory.transfer", scopeOf(wh)),
      canDeliver: hasPermission(ctx.grants, "b2b.manage"),
    };
  });
}

/** A wave with its lists and one consolidated, walk-ordered pick sheet. */
export async function getWave(ctx: TenantContext, waveId: string) {
  if (!isUuid(waveId)) throw notFound("Wave");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wave = await tx.pickWave.findFirst({
      where: { organizationId: ctx.organizationId, id: waveId },
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        pickLists: {
          include: {
            ...listInclude,
            lines: { include: lineInclude, orderBy: { sequence: "asc" } },
          },
          orderBy: { number: "asc" },
        },
      },
    });
    if (!wave) throw notFound("Wave");
    await loadWarehouseFor(tx, ctx, wave.warehouseId);
    // One row per place, product and lot, summing the open lists.
    const rows = new Map<
      string,
      {
        locationCode: string | null;
        sku: string;
        product: (typeof wave.pickLists)[number]["lines"][number]["product"];
        lot: (typeof wave.pickLists)[number]["lines"][number]["lot"];
        quantity: Decimal;
        lists: string[];
      }
    >();
    for (const list of wave.pickLists.filter((l) => l.status === "PLANNED"))
      for (const l of list.lines) {
        const key = `${l.locationId}|${l.productId}|${l.lotId}`;
        const row = rows.get(key) ?? {
          locationCode: l.location?.code ?? null,
          sku: l.product.sku,
          product: l.product,
          lot: l.lot,
          quantity: new Decimal(0),
          lists: [],
        };
        row.quantity = row.quantity.plus(dec(l.plannedQuantity));
        if (!row.lists.includes(list.number)) row.lists.push(list.number);
        rows.set(key, row);
      }
    return { ...wave, sheet: walkOrder([...rows.values()]) };
  });
}

/** Confirmed orders of a warehouse without an open pick list, for planning a wave. */
export async function ordersToPick(ctx: TenantContext, warehouseId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wh = await loadWarehouseFor(tx, ctx, warehouseId);
    return tx.salesOrder.findMany({
      where: {
        organizationId: ctx.organizationId,
        warehouseId: wh.id,
        status: { in: ["CONFIRMED", "PARTIALLY_DELIVERED"] },
        pickLists: { none: { status: { in: ["PLANNED", "PICKED"] } } },
      },
      select: {
        id: true,
        number: true,
        requestedOn: true,
        customer: { select: { code: true, name: true } },
      },
      orderBy: [{ requestedOn: "asc" }, { number: "asc" }],
      take: 100,
    });
  });
}
