import "server-only";
import { Decimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import {
  holdLotsInTx,
  setRecallHoldInTx,
  writeOffHeldLotsInTx,
} from "@/modules/inventory/recall-postings";
import { businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import {
  cancelRecallSchema,
  closeRecallSchema,
  createRecallSchema,
  recallLotsSchema,
} from "./schemas";
import { lotStock } from "./trace";

/**
 * Recalls (DECISIONS.md ADR-034). A DRAFT recall is a simulation of its
 * scope; activating it puts the lots on recall hold and moves their usable
 * stock to ON_HOLD in every warehouse; closing either writes the held stock
 * off (DISPOSED) or lifts the recall hold (RELEASED).
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());

async function audit(
  tx: Tx,
  ctx: TenantContext,
  recall: { id: string; number: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `recall.${action}`,
    entityType: "recall",
    entityId: recall.id,
    changes: { number: recall.number, ...changes },
  });
}

async function lockRecall(tx: Tx, ctx: TenantContext, recallId: string) {
  await tx.$queryRaw`
    SELECT "id" FROM "recalls"
    WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${recallId}::uuid
    FOR UPDATE`;
  const recall = await tx.recall.findFirst({
    where: { organizationId: ctx.organizationId, id: recallId },
    include: { lots: true },
  });
  if (!recall) throw notFound("Recall");
  return recall;
}

function requireStatus(ok: boolean, status: string) {
  if (!ok)
    throw businessRuleViolation("RECALL_STATUS", "Not possible in the recall's status", { status });
}

export async function createRecall(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "recalls.manage");
  const parsed = createRecallSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const year = Number(businessDate(ctx.timeZone).slice(0, 4));
    const number = await nextDocumentNumber(tx, ctx.organizationId, "RCL", year);
    const recall = await tx.recall.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        ...parsed.data,
        createdByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    await audit(tx, ctx, recall, "created", parsed.data);
    return recall;
  });
}

export async function addRecallLots(ctx: TenantContext, recallId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "recalls.manage");
  const parsed = recallLotsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const recall = await lockRecall(tx, ctx, recallId);
    requireStatus(recall.status === "DRAFT", recall.status);
    const lots = await tx.inventoryLot.findMany({
      where: { organizationId: ctx.organizationId, id: { in: parsed.data.lotIds } },
      select: { id: true, productId: true },
    });
    if (lots.length !== new Set(parsed.data.lotIds).size) throw notFound("Lot");
    const existing = new Set(recall.lots.map((l) => l.lotId));
    const added = lots.filter((l) => !existing.has(l.id));
    if (added.length > 0)
      await tx.recallLot.createMany({
        data: added.map((l) => ({
          organizationId: ctx.organizationId,
          recallId: recall.id,
          productId: l.productId,
          lotId: l.id,
        })),
      });
    await audit(tx, ctx, recall, "lots_added", { lotIds: added.map((l) => l.id) });
    return { added: added.length };
  });
}

export async function removeRecallLot(ctx: TenantContext, recallId: string, lotId: string) {
  assertPermission(ctx.grants, "recalls.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const recall = await lockRecall(tx, ctx, recallId);
    requireStatus(recall.status === "DRAFT", recall.status);
    const line = recall.lots.find((l) => l.lotId === lotId);
    if (!line) throw notFound("Recall lot");
    await tx.recallLot.delete({ where: { id: line.id } });
    await audit(tx, ctx, recall, "lot_removed", { lotId });
  });
}

/** Go live: recall hold on the lots, usable stock to ON_HOLD, stock snapshot stored. */
export async function activateRecall(ctx: TenantContext, recallId: string) {
  assertPermission(ctx.grants, "recalls.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const recall = await lockRecall(tx, ctx, recallId);
    requireStatus(recall.status === "DRAFT", recall.status);
    if (recall.lots.length === 0)
      throw businessRuleViolation("RECALL_HAS_NO_LOTS", "Add at least one lot first");
    const lotIds = recall.lots.map((l) => l.lotId);
    await setRecallHoldInTx(tx, ctx, lotIds, true);
    const stock = await lotStock(tx, ctx, lotIds);
    if (stock.length > 0)
      await tx.recallStock.createMany({
        data: stock.map((s) => ({
          organizationId: ctx.organizationId,
          recallId: recall.id,
          productId: s.productId,
          lotId: s.lotId as string,
          warehouseId: s.warehouseId,
          locationId: s.locationId,
          stockStatus: s.stockStatus,
          quantity: s.onHandQuantity,
        })),
      });
    const documents = await holdLotsInTx(tx, ctx, lotIds, `Recall ${recall.number}`);
    if (documents.length > 0)
      await tx.recallDocument.createMany({
        data: documents.map((documentId) => ({
          organizationId: ctx.organizationId,
          recallId: recall.id,
          documentId,
          kind: "HOLD" as const,
        })),
      });
    await tx.recall.update({
      where: { id: recall.id },
      data: { status: "ACTIVE", activatedAt: new Date(), activatedByUserId: ctx.userId },
    });
    await audit(tx, ctx, recall, "activated", { lots: lotIds.length, documents: documents.length });
    return { documents: documents.length };
  });
}

/** Lots of this recall that no other active recall still holds. */
async function releasableLots(tx: Tx, ctx: TenantContext, recallId: string, lotIds: string[]) {
  const others = await tx.recallLot.findMany({
    where: {
      organizationId: ctx.organizationId,
      lotId: { in: lotIds },
      recallId: { not: recallId },
      recall: { status: "ACTIVE" },
    },
    select: { lotId: true },
  });
  const held = new Set(others.map((o) => o.lotId));
  return lotIds.filter((id) => !held.has(id));
}

export async function closeRecall(ctx: TenantContext, recallId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "recalls.manage");
  const parsed = closeRecallSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { outcome, note } = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const recall = await lockRecall(tx, ctx, recallId);
    requireStatus(recall.status === "ACTIVE", recall.status);
    const lotIds = recall.lots.map((l) => l.lotId);
    let documents: string[] = [];
    if (outcome === "DISPOSED") {
      documents = await writeOffHeldLotsInTx(tx, ctx, lotIds, `Recall ${recall.number}: ${note}`);
      if (documents.length > 0)
        await tx.recallDocument.createMany({
          data: documents.map((documentId) => ({
            organizationId: ctx.organizationId,
            recallId: recall.id,
            documentId,
            kind: "DISPOSAL" as const,
          })),
        });
    } else {
      await setRecallHoldInTx(tx, ctx, await releasableLots(tx, ctx, recall.id, lotIds), false);
    }
    await tx.recall.update({
      where: { id: recall.id },
      data: {
        status: "CLOSED",
        outcome,
        closedAt: new Date(),
        closedByUserId: ctx.userId,
        closeNote: note,
      },
    });
    await audit(tx, ctx, recall, "closed", { outcome, note, documents: documents.length });
    return { documents: documents.length };
  });
}

/** Drop a recall that never went live. */
export async function cancelRecall(ctx: TenantContext, recallId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "recalls.manage");
  const parsed = cancelRecallSchema.safeParse(rawInput ?? {});
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const recall = await lockRecall(tx, ctx, recallId);
    requireStatus(recall.status === "DRAFT", recall.status);
    await tx.recall.update({
      where: { id: recall.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        closedByUserId: ctx.userId,
        closeNote: parsed.data.note ?? null,
      },
    });
    await audit(tx, ctx, recall, "cancelled", parsed.data);
  });
}

export async function listRecalls(ctx: TenantContext) {
  assertPermission(ctx.grants, "traceability.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.recall.findMany({
      where: { organizationId: ctx.organizationId },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        outcome: true,
        createdAt: true,
        activatedAt: true,
        closedAt: true,
        _count: { select: { lots: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  );
}

/**
 * A recall with its scope, suppliers and receipts, stock now (the
 * simulation while DRAFT), stock at activation and the documents posted.
 */
export async function getRecall(ctx: TenantContext, recallId: string) {
  assertPermission(ctx.grants, "traceability.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const recall = await tx.recall.findFirst({
      where: { organizationId: ctx.organizationId, id: recallId },
      include: {
        lots: {
          include: {
            lot: {
              select: {
                id: true,
                lotCode: true,
                expiresOn: true,
                recallHold: true,
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
          },
          orderBy: { addedAt: "asc" },
        },
        stock: {
          include: {
            warehouse: { select: { code: true, name: true } },
            lot: { select: { lotCode: true } },
          },
          orderBy: [{ warehouseId: "asc" }, { stockStatus: "asc" }],
        },
        documents: {
          include: {
            document: {
              select: { id: true, number: true, type: true, warehouse: { select: { code: true } } },
            },
          },
        },
      },
    });
    if (!recall) throw notFound("Recall");
    const lotIds = recall.lots.map((l) => l.lotId);
    const stockNow = await lotStock(tx, ctx, lotIds);
    const receipts = await tx.goodsReceiptLine.findMany({
      where: { organizationId: ctx.organizationId, lotId: { in: lotIds } },
      select: {
        lotId: true,
        acceptedQuantity: true,
        uom: { select: { code: true } },
        receipt: {
          select: {
            id: true,
            number: true,
            status: true,
            receivedAt: true,
            supplier: {
              select: { id: true, code: true, name: true, nameAr: true, phone: true, email: true },
            },
          },
        },
      },
    });
    const movements = await tx.inventoryLedgerEntry.groupBy({
      by: ["lotId", "movementType"],
      where: { organizationId: ctx.organizationId, lotId: { in: lotIds } },
      _sum: { quantityDelta: true },
    });
    const sum = (lotId: string, types: string[], sign: 1 | -1) =>
      movements
        .filter((m) => m.lotId === lotId && types.includes(m.movementType))
        .reduce((a, m) => a.plus(dec(m._sum.quantityDelta ?? 0).times(sign)), new Decimal(0));
    const inTransit = stockNow.filter((s) => s.stockStatus === "IN_TRANSIT");
    const users = await tx.user.findMany({
      where: {
        id: {
          in: [recall.createdByUserId, recall.activatedByUserId, recall.closedByUserId].filter(
            (v): v is string => !!v,
          ),
        },
      },
      select: { id: true, name: true },
    });
    const name = (id: string | null) =>
      id ? (users.find((u) => u.id === id)?.name ?? null) : null;
    return {
      ...recall,
      names: {
        createdBy: name(recall.createdByUserId),
        activatedBy: name(recall.activatedByUserId),
        closedBy: name(recall.closedByUserId),
      },
      lotSummaries: recall.lots.map((l) => ({
        lotId: l.lotId,
        received: sum(
          l.lotId,
          ["RECEIPT", "OPENING_BALANCE", "PRODUCTION_OUTPUT", "CUSTOMER_RETURN"],
          1,
        ),
        writtenOff: sum(l.lotId, ["WRITE_OFF"], -1),
        used: sum(l.lotId, ["CONSUMPTION"], -1),
        onHand: stockNow
          .filter((s) => s.lotId === l.lotId)
          .reduce((a, s) => a.plus(dec(s.onHandQuantity)), new Decimal(0)),
      })),
      stockNow,
      inTransit,
      receipts,
      suppliers: [
        ...new Map(receipts.map((r) => [r.receipt.supplier.id, r.receipt.supplier])).values(),
      ],
    };
  });
}
