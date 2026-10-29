import "server-only";
import { Decimal } from "@/lib/decimal";
import { uuidv7 } from "@/lib/uuid";
import { accessibleScope } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import {
  assertActive,
  assertWarehousePermission,
  loadLocation,
  loadProductForPosting,
  loadWarehouse,
  resolveInboundLot,
  todayFor,
} from "./context";
import { nextDocumentNumber, postDocument, type PostingLine } from "./posting";
import { countAdjustment } from "./rules";
import { addCountLineSchema, createCountSchema, recordCountSchema } from "./schemas";

/**
 * Stock counts (cycle counts) of AVAILABLE stock in one warehouse, optionally
 * one location. Lifecycle: OPEN → SUBMITTED → POSTED, or → CANCELLED.
 *
 * The system quantity of a line is captured when the line is counted, and the
 * posted adjustment is counted − system quantity at that moment. Movements
 * after a line was counted are already in the balance, so they are neither
 * lost nor double-counted (DATA_MODEL.md §4, stock counts).
 */

const PAGE_SIZE = 25;

async function currentOnHand(
  tx: Tx,
  ctx: TenantContext,
  b: { warehouseId: string; locationId: string | null; productId: string; lotId: string | null },
): Promise<Decimal> {
  const rows = await tx.$queryRaw<Array<{ on_hand_quantity: unknown }>>`
    SELECT "on_hand_quantity" FROM "stock_balances"
    WHERE "organization_id" = ${ctx.organizationId}::uuid AND "warehouse_id" = ${b.warehouseId}::uuid
      AND "location_id" IS NOT DISTINCT FROM ${b.locationId}::uuid AND "product_id" = ${b.productId}::uuid
      AND "lot_id" IS NOT DISTINCT FROM ${b.lotId}::uuid AND "stock_status" = 'AVAILABLE'`;
  return rows[0] ? new Decimal(String(rows[0].on_hand_quantity)) : new Decimal(0);
}

async function loadCount(
  tx: Tx,
  ctx: TenantContext,
  countId: string,
  options: { lock?: boolean } = {},
) {
  if (options.lock) {
    await tx.$queryRaw`SELECT 1 FROM "stock_counts" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${countId}::uuid FOR UPDATE`;
  }
  const count = await tx.stockCount.findFirst({
    where: { organizationId: ctx.organizationId, id: countId },
    select: {
      id: true,
      number: true,
      status: true,
      warehouseId: true,
      locationId: true,
      snapshotAt: true,
      note: true,
      documentId: true,
      createdAt: true,
      submittedAt: true,
      postedAt: true,
      document: { select: { id: true, number: true } },
      location: { select: { code: true, name: true } },
    },
  });
  if (!count) throw notFound("Stock count");
  const wh = await loadWarehouse(tx, ctx, count.warehouseId);
  return { count, wh };
}

function assertStatus(status: string, allowed: string[]) {
  if (!allowed.includes(status))
    throw businessRuleViolation("COUNT_STATUS", `This count is ${status.toLowerCase()}`, {
      status,
    });
}

export async function createCount(
  ctx: TenantContext,
  rawInput: unknown,
): Promise<{ id: string; number: string }> {
  const parsed = createCountSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "inventory.count_create", input },
    async (tx) => {
      const wh = await loadWarehouse(tx, ctx, input.warehouseId);
      assertWarehousePermission(ctx, "inventory.count", wh);
      assertActive(wh);
      const locationId = await loadLocation(tx, ctx, wh.id, input.locationId, true);
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "SC",
        Number(todayFor(wh).slice(0, 4)),
      );
      const id = uuidv7();
      await tx.stockCount.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          number,
          warehouseId: wh.id,
          locationId,
          note: input.note,
          createdByUserId: ctx.userId,
        },
      });
      // Count sheet: every AVAILABLE bucket with stock in scope.
      const buckets = await tx.stockBalance.findMany({
        where: {
          organizationId: ctx.organizationId,
          warehouseId: wh.id,
          stockStatus: "AVAILABLE",
          onHandQuantity: { gt: 0 },
          ...(locationId ? { locationId } : {}),
        },
        select: { productId: true, lotId: true, locationId: true, onHandQuantity: true },
      });
      if (buckets.length > 0) {
        await tx.stockCountLine.createMany({
          data: buckets.map((b) => ({
            organizationId: ctx.organizationId,
            countId: id,
            productId: b.productId,
            lotId: b.lotId,
            locationId: b.locationId,
            expectedQuantity: b.onHandQuantity,
          })),
        });
      }
      await recordAudit(tx, actorOf(ctx), {
        action: "stock_count.created",
        entityType: "stock_count",
        entityId: id,
        changes: { number, lines: buckets.length },
      });
      return { id, number };
    },
  );
}

export async function recordCountedQuantity(
  ctx: TenantContext,
  countId: string,
  lineId: string,
  rawInput: unknown,
): Promise<void> {
  const parsed = recordCountSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { count, wh } = await loadCount(tx, ctx, countId, { lock: true });
    assertWarehousePermission(ctx, "inventory.count", wh);
    assertStatus(count.status, ["OPEN"]);
    const lineRow = await tx.stockCountLine.findFirst({
      where: { organizationId: ctx.organizationId, countId, id: lineId },
    });
    if (!lineRow) throw notFound("Count line");
    const systemQuantity = await currentOnHand(tx, ctx, {
      warehouseId: count.warehouseId,
      ...lineRow,
    });
    await tx.stockCountLine.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: lineId } },
      data: {
        countedQuantity: parsed.data.countedQuantity,
        expectedQuantity: systemQuantity.toFixed(),
        countedByUserId: ctx.userId,
        countedAt: new Date(),
      },
    });
  });
}

/** Add an item found during counting that is not on the count sheet. */
export async function addCountLine(
  ctx: TenantContext,
  countId: string,
  rawInput: unknown,
): Promise<{ id: string }> {
  const parsed = addCountLineSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const { count, wh } = await loadCount(tx, ctx, countId, { lock: true });
      assertWarehousePermission(ctx, "inventory.count", wh);
      assertStatus(count.status, ["OPEN"]);
      const locationId =
        count.locationId ?? (await loadLocation(tx, ctx, wh.id, parsed.data.locationId, true));
      const product = await loadProductForPosting(tx, ctx, parsed.data.productId);
      const lot = await resolveInboundLot(tx, ctx, product, parsed.data);
      const expected = await currentOnHand(tx, ctx, {
        warehouseId: wh.id,
        locationId,
        productId: product.id,
        lotId: lot?.id ?? null,
      });
      const line = await tx.stockCountLine.create({
        data: {
          organizationId: ctx.organizationId,
          countId,
          productId: product.id,
          lotId: lot?.id ?? null,
          locationId,
          expectedQuantity: expected.toFixed(),
        },
        select: { id: true },
      });
      return line;
    });
  } catch (error) {
    if (isUniqueViolation(error, "stock_count_lines_item_key"))
      throw conflict("This item is already on the count", { reason: "countLineExists" });
    throw error;
  }
}

export async function submitCount(ctx: TenantContext, countId: string): Promise<void> {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { count, wh } = await loadCount(tx, ctx, countId, { lock: true });
    assertWarehousePermission(ctx, "inventory.count", wh);
    assertStatus(count.status, ["OPEN"]);
    const uncounted = await tx.stockCountLine.count({
      where: { organizationId: ctx.organizationId, countId, countedQuantity: null },
    });
    if (uncounted > 0)
      throw businessRuleViolation(
        "COUNT_INCOMPLETE",
        "Every line must be counted (enter 0 for none)",
        { uncounted },
      );
    await tx.stockCount.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: countId } },
      data: { status: "SUBMITTED", submittedByUserId: ctx.userId, submittedAt: new Date() },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "stock_count.submitted",
      entityType: "stock_count",
      entityId: countId,
    });
  });
}

/** Approve a submitted count: post COUNT_ADJUSTMENT entries for all differences. */
export async function postCount(
  ctx: TenantContext,
  countId: string,
): Promise<{ documentNumber: string | null }> {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { count, wh } = await loadCount(tx, ctx, countId, { lock: true });
    assertWarehousePermission(ctx, "inventory.count.approve", wh);
    assertStatus(count.status, ["SUBMITTED"]);
    const rows = await tx.stockCountLine.findMany({
      where: { organizationId: ctx.organizationId, countId },
      select: {
        id: true,
        productId: true,
        lotId: true,
        locationId: true,
        expectedQuantity: true,
        countedQuantity: true,
        product: { select: { baseUomId: true } },
      },
      orderBy: { id: "asc" },
    });
    const lines: PostingLine[] = [];
    for (const r of rows) {
      const delta = countAdjustment(r.expectedQuantity.toString(), r.countedQuantity!.toString());
      if (delta.isZero()) continue;
      lines.push({
        movementType: "COUNT_ADJUSTMENT",
        warehouseId: count.warehouseId,
        locationId: r.locationId,
        productId: r.productId,
        lotId: r.lotId,
        stockStatus: "AVAILABLE",
        quantityDelta: delta,
        enteredQuantity: delta,
        enteredUomId: r.product.baseUomId,
        sourceLineId: r.id,
        postingKey: `count:${r.id}`,
        reasonCode: "STOCK_COUNT",
      });
    }
    let documentId: string | null = null;
    let documentNumber: string | null = null;
    if (lines.length > 0) {
      const posted = await postDocument(
        tx,
        ctx,
        {
          type: "STOCK_COUNT",
          warehouseId: count.warehouseId,
          reasonCode: "STOCK_COUNT",
          note: `${count.number}${count.note ? ` — ${count.note}` : ""}`,
        },
        lines,
        { year: Number(todayFor(wh).slice(0, 4)), auditChanges: { count: count.number } },
      );
      documentId = posted.documentId;
      documentNumber = posted.number;
    }
    await tx.stockCount.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: countId } },
      data: { status: "POSTED", postedByUserId: ctx.userId, postedAt: new Date(), documentId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "stock_count.posted",
      entityType: "stock_count",
      entityId: countId,
      changes: { adjustments: lines.length, document: documentNumber },
    });
    return { documentNumber };
  });
}

export async function cancelCount(ctx: TenantContext, countId: string): Promise<void> {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { count, wh } = await loadCount(tx, ctx, countId, { lock: true });
    assertWarehousePermission(ctx, "inventory.count", wh);
    assertStatus(count.status, ["OPEN", "SUBMITTED"]);
    await tx.stockCount.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: countId } },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "stock_count.cancelled",
      entityType: "stock_count",
      entityId: countId,
    });
  });
}

export async function getCount(ctx: TenantContext, countId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { count, wh } = await loadCount(tx, ctx, countId);
    const lines = await tx.stockCountLine.findMany({
      where: { organizationId: ctx.organizationId, countId },
      select: {
        id: true,
        expectedQuantity: true,
        countedQuantity: true,
        countedAt: true,
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
        location: { select: { code: true } },
      },
      orderBy: [{ product: { sku: "asc" } }, { id: "asc" }],
    });
    return { ...count, warehouse: wh, lines };
  });
}

export async function listCounts(ctx: TenantContext, options: { page?: number } = {}) {
  const page = Math.max(1, options.page ?? 1);
  const scope = accessibleScope(ctx.grants, "inventory.view");
  const where = {
    organizationId: ctx.organizationId,
    ...(scope.all
      ? {}
      : {
          warehouse: {
            OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }],
          },
        }),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.stockCount.count({ where }),
      tx.stockCount.findMany({
        where,
        select: {
          id: true,
          number: true,
          status: true,
          createdAt: true,
          postedAt: true,
          warehouse: { select: { code: true, name: true } },
          location: { select: { code: true } },
          _count: { select: { lines: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return { items, total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
  });
}
