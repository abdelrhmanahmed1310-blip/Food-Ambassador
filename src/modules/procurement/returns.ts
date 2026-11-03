import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal, roundMoney, roundQuantity } from "@/lib/decimal";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { postSupplierReturnInTx, reverseDocumentInTx } from "@/modules/inventory/operations";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import { runIdempotent } from "@/modules/shared/idempotency";
import {
  idempotencyKeySchema,
  optionalText,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { canOnWarehouse, loadWarehouseRef, warehouseScope } from "./orders";

/**
 * Supplier returns (DECISIONS.md ADR-094): goods sent back after they were
 * accepted. A return is started from a posted receipt and may take lines
 * from any posted receipt of the same supplier, warehouse and currency;
 * each line keeps the receipt's product, lot, unit and charged price. Posting
 * takes the stock out through the inventory ledger (at average cost, like any
 * issue); the expected credit is quantity × charged price. The supplier's
 * credit note is linked when it arrives. A posted return not yet credited can
 * be reversed (the goods came back). Receivers (`purchasing.receive`) create,
 * post and reverse; `invoices.manage` links the credit note.
 */

export const RETURN_REASONS = [
  "QUALITY",
  "DAMAGED",
  "EXPIRED",
  "WRONG_ITEM",
  "RECALL",
  "OVERSUPPLY",
  "OTHER",
] as const;
export const RETURN_STATUSES = ["DRAFT", "POSTED", "CREDITED", "REVERSED", "CANCELLED"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export const RETURN_PAGE_SIZE = 25;

const dec = (v: { toString(): string }) => new Decimal(v.toString());

const createSchema = z.object({
  receiptId: uuidSchema,
  reason: z.enum(RETURN_REASONS, { error: "invalidOption" }),
  note: optionalText(1000),
  idempotencyKey: idempotencyKeySchema,
});
const lineSchema = z.object({
  receiptLineId: uuidSchema,
  quantity: z
    .string()
    .transform((v) => v.trim())
    .refine((v) => /^\d+(\.\d{1,6})?$/.test(v) && Number(v) > 0, { error: "invalidQuantity" }),
  fromStatus: z.enum(["AVAILABLE", "QUARANTINE"], { error: "invalidOption" }),
});
const reasonSchema = z.object({ reason: requiredText(500) });
const creditSchema = z.object({ creditNoteId: uuidSchema });

type WarehouseRef = Awaited<ReturnType<typeof loadWarehouseRef>>;
const target = (wh: WarehouseRef) => ({ branchId: wh.branchId, warehouseId: wh.id });

async function lockReturn(tx: Tx, ctx: TenantContext, returnId: string) {
  await tx.$queryRaw`SELECT 1 FROM "supplier_returns" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${returnId}::uuid FOR UPDATE`;
  const ret = await tx.supplierReturn.findFirst({
    where: { organizationId: ctx.organizationId, id: returnId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!ret) throw notFound("Supplier return");
  const wh = await loadWarehouseRef(tx, ctx, ret.warehouseId);
  if (!canOnWarehouse(ctx, "purchasing.view", wh)) throw notFound("Supplier return");
  return { ...ret, warehouse: wh };
}
type LockedReturn = Awaited<ReturnType<typeof lockReturn>>;

const requireReceive = (ctx: TenantContext, ret: LockedReturn) =>
  assertPermission(ctx.grants, "purchasing.receive", target(ret.warehouse));

function requireStatus(ret: LockedReturn, ...allowed: ReturnStatus[]) {
  if (!allowed.includes(ret.status))
    throw businessRuleViolation("RETURN_STATUS", "Not possible in the return's status", {
      status: ret.status,
    });
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  ret: { id: string; number: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `supplier_return.${action}`,
    entityType: "supplier_return",
    entityId: ret.id,
    changes: { number: ret.number, ...changes },
  });
}

/** Quantity (receipt unit) already sent back on posted or credited returns, per receipt line. */
async function returnedSoFar(
  tx: Tx,
  ctx: TenantContext,
  receiptLineIds: string[],
  except?: string,
) {
  if (receiptLineIds.length === 0) return new Map<string, Decimal>();
  const rows = await tx.supplierReturnLine.groupBy({
    by: ["receiptLineId"],
    where: {
      organizationId: ctx.organizationId,
      receiptLineId: { in: receiptLineIds },
      supplierReturn: {
        status: { in: ["POSTED", "CREDITED"] },
        ...(except ? { id: { not: except } } : {}),
      },
    },
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [r.receiptLineId, dec(r._sum.quantity ?? 0)]));
}

// ─── Draft ───

/** Start a return from a posted receipt: its supplier, warehouse and currency. */
export async function createSupplierReturn(ctx: TenantContext, rawInput: unknown) {
  const parsed = createSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "supplier_return.create", input },
    async (tx) => {
      const receipt = await tx.goodsReceipt.findFirst({
        where: { organizationId: ctx.organizationId, id: input.receiptId },
        select: {
          id: true,
          number: true,
          status: true,
          supplierId: true,
          warehouseId: true,
          currency: true,
        },
      });
      if (!receipt) throw notFound("Receipt");
      const wh = await loadWarehouseRef(tx, ctx, receipt.warehouseId);
      if (!canOnWarehouse(ctx, "purchasing.view", wh)) throw notFound("Receipt");
      assertPermission(ctx.grants, "purchasing.receive", target(wh));
      if (receipt.status !== "POSTED")
        throw businessRuleViolation("RECEIPT_NOT_POSTED", "The receipt was reversed");
      const today = businessDate(wh.branch.timeZone ?? ctx.timeZone);
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "RTS",
        Number(today.slice(0, 4)),
      );
      const ret = await tx.supplierReturn.create({
        data: {
          organizationId: ctx.organizationId,
          number,
          supplierId: receipt.supplierId,
          warehouseId: receipt.warehouseId,
          currency: receipt.currency,
          reason: input.reason,
          note: input.note ?? null,
          createdByUserId: ctx.userId,
        },
        select: { id: true, number: true },
      });
      await audit(tx, ctx, ret, "created", { receipt: receipt.number, reason: input.reason });
      return ret;
    },
  );
}

/** Receipt lines this return could take from: same supplier, warehouse and currency, still returnable. */
async function returnableInTx(tx: Tx, ctx: TenantContext, ret: LockedReturn) {
  const lines = await tx.goodsReceiptLine.findMany({
    where: {
      organizationId: ctx.organizationId,
      acceptedQuantity: { gt: 0 },
      receipt: {
        status: "POSTED",
        supplierId: ret.supplierId,
        warehouseId: ret.warehouseId,
        currency: ret.currency,
      },
    },
    include: {
      receipt: { select: { id: true, number: true, receivedAt: true, locationId: true } },
      product: { select: { id: true, sku: true, nameEn: true, nameAr: true } },
      uom: { select: { code: true } },
      lot: { select: { lotCode: true, expiresOn: true } },
    },
    orderBy: [{ receipt: { receivedAt: "desc" } }],
    take: 300,
  });
  const returned = await returnedSoFar(
    tx,
    ctx,
    lines.map((l) => l.id),
  );
  return lines
    .map((l) => ({
      ...l,
      remaining: dec(l.acceptedQuantity).minus(returned.get(l.id) ?? 0),
      onThisReturn: ret.lines.some((x) => x.receiptLineId === l.id),
    }))
    .filter((l) => l.remaining.greaterThan(0));
}

export async function addSupplierReturnLine(
  ctx: TenantContext,
  returnId: string,
  rawInput: unknown,
) {
  const parsed = lineSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const ret = await lockReturn(tx, ctx, returnId);
      requireReceive(ctx, ret);
      requireStatus(ret, "DRAFT");
      const rl = (await returnableInTx(tx, ctx, ret)).find((l) => l.id === v.receiptLineId);
      if (!rl) throw notFound("Receipt line");
      const quantity = new Decimal(v.quantity);
      if (quantity.greaterThan(rl.remaining))
        throw businessRuleViolation("RETURN_EXCEEDS_RECEIVED", "More than is left to return", {
          field: "quantity",
          remaining: rl.remaining.toFixed(),
        });
      // The receipt line's own ratio to the base unit (it was converted once, at receipt).
      const quantityBase = roundQuantity(
        quantity.times(dec(rl.acceptedQuantityBase)).dividedBy(dec(rl.acceptedQuantity)),
      );
      const lineNo = (ret.lines.at(-1)?.lineNo ?? 0) + 1;
      const lineTotal = roundMoney(quantity.times(dec(rl.unitPrice)));
      const line = await tx.supplierReturnLine.create({
        data: {
          organizationId: ctx.organizationId,
          returnId: ret.id,
          lineNo,
          receiptLineId: rl.id,
          productId: rl.productId,
          lotId: rl.lotId,
          uomId: rl.uomId,
          quantity: quantity.toFixed(),
          quantityBase: quantityBase.toFixed(),
          unitPrice: dec(rl.unitPrice).toFixed(),
          lineTotal: lineTotal.toFixed(),
          fromStatus: v.fromStatus,
        },
        select: { id: true },
      });
      await recomputeTotal(tx, ret.id);
      await audit(tx, ctx, ret, "line_added", {
        lineNo,
        receipt: rl.receipt.number,
        productId: rl.productId,
        quantity: quantity.toFixed(),
        fromStatus: v.fromStatus,
      });
      return line;
    });
  } catch (error) {
    if (isUniqueViolation(error, "supplier_return_lines_organization_id_return_id_receipt_lin_key"))
      throw conflict("This receipt line is already on the return", {
        field: "receiptLineId",
        reason: "lineOnReturn",
      });
    throw error;
  }
}

async function recomputeTotal(tx: Tx, returnId: string) {
  const lines = await tx.supplierReturnLine.findMany({
    where: { returnId },
    select: { lineTotal: true },
  });
  const total = lines.reduce((a, l) => a.plus(dec(l.lineTotal)), new Decimal(0));
  await tx.supplierReturn.update({
    where: { id: returnId },
    data: { totalAmount: total.toFixed() },
  });
}

export async function removeSupplierReturnLine(
  ctx: TenantContext,
  returnId: string,
  lineId: string,
) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const ret = await lockReturn(tx, ctx, returnId);
    requireReceive(ctx, ret);
    requireStatus(ret, "DRAFT");
    const line = ret.lines.find((l) => l.id === lineId);
    if (!line) throw notFound("Return line");
    await tx.supplierReturnLine.delete({ where: { id: line.id } });
    await recomputeTotal(tx, ret.id);
    await audit(tx, ctx, ret, "line_removed", { lineNo: line.lineNo });
  });
}

export async function cancelSupplierReturn(
  ctx: TenantContext,
  returnId: string,
  rawInput: unknown,
) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const ret = await lockReturn(tx, ctx, returnId);
    requireReceive(ctx, ret);
    requireStatus(ret, "DRAFT");
    await tx.supplierReturn.update({
      where: { id: ret.id },
      data: {
        status: "CANCELLED",
        decidedAt: new Date(),
        decidedByUserId: ctx.userId,
        decisionReason: parsed.data.reason,
      },
    });
    await audit(tx, ctx, ret, "cancelled", { reason: parsed.data.reason });
  });
}

// ─── Post, reverse, credit ───

/** Take the goods out of stock. Nothing more than was accepted can leave (also checked by the database). */
export async function postSupplierReturn(ctx: TenantContext, returnId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const ret = await lockReturn(tx, ctx, returnId);
    requireReceive(ctx, ret);
    requireStatus(ret, "DRAFT");
    if (ret.lines.length === 0)
      throw businessRuleViolation("RETURN_HAS_NO_LINES", "Add at least one line first");
    // Serialize returns per supplier, so the same receipt line is not returned twice at once.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-returns:${ctx.organizationId}:${ret.supplierId}`}))`;
    const ids = ret.lines.map((l) => l.receiptLineId);
    const receiptLines = await tx.goodsReceiptLine.findMany({
      where: { organizationId: ctx.organizationId, id: { in: ids } },
      select: {
        id: true,
        acceptedQuantity: true,
        receipt: { select: { locationId: true, status: true } },
      },
    });
    const returned = await returnedSoFar(tx, ctx, ids, ret.id);
    for (const [index, l] of ret.lines.entries()) {
      const rl = receiptLines.find((r) => r.id === l.receiptLineId)!;
      if (rl.receipt.status !== "POSTED")
        throw businessRuleViolation("RECEIPT_NOT_POSTED", "A receipt on this return was reversed", {
          line: index + 1,
        });
      const left = dec(rl.acceptedQuantity).minus(returned.get(rl.id) ?? 0);
      if (dec(l.quantity).greaterThan(left))
        throw businessRuleViolation("RETURN_EXCEEDS_RECEIVED", "More than is left to return", {
          line: index + 1,
          remaining: left.toFixed(),
        });
    }
    const posting = await postSupplierReturnInTx(tx, ctx, {
      warehouseId: ret.warehouseId,
      returnNumber: ret.number,
      note: ret.note ?? undefined,
      lines: ret.lines.map((l) => ({
        sourceLineId: l.id,
        locationId: receiptLines.find((r) => r.id === l.receiptLineId)!.receipt.locationId,
        productId: l.productId,
        lotId: l.lotId,
        uomId: l.uomId,
        quantity: dec(l.quantity).toFixed(),
        quantityBase: dec(l.quantityBase).toFixed(),
        stockStatus: l.fromStatus as "AVAILABLE" | "QUARANTINE",
      })),
    });
    await tx.supplierReturn.update({
      where: { id: ret.id },
      data: {
        status: "POSTED",
        inventoryDocumentId: posting.documentId,
        postedAt: new Date(),
        postedByUserId: ctx.userId,
      },
    });
    await audit(tx, ctx, ret, "posted", {
      inventoryDocument: posting.number,
      total: dec(ret.totalAmount).toFixed(),
      currency: ret.currency,
    });
    return { documentNumber: posting.number };
  });
}

/** The supplier refused the goods and they came back: the stock is put back as it left. */
export async function reverseSupplierReturn(
  ctx: TenantContext,
  returnId: string,
  rawInput: unknown,
) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const ret = await lockReturn(tx, ctx, returnId);
    requireReceive(ctx, ret);
    requireStatus(ret, "POSTED");
    const reversal = await reverseDocumentInTx(
      tx,
      ctx,
      ret.inventoryDocumentId!,
      { reasonCode: "SUPPLIER_RETURN_REVERSED", note: parsed.data.reason },
      { allowReceipt: false, allowSupplierReturn: true, permission: "purchasing.receive" },
    );
    await tx.supplierReturn.update({
      where: { id: ret.id },
      data: {
        status: "REVERSED",
        reversalDocumentId: reversal.documentId,
        decidedAt: new Date(),
        decidedByUserId: ctx.userId,
        decisionReason: parsed.data.reason,
      },
    });
    await audit(tx, ctx, ret, "reversed", {
      reason: parsed.data.reason,
      reversal: reversal.number,
    });
  });
}

/** Close a posted return with the supplier's credit note (same supplier and currency). */
export async function linkReturnCreditNote(
  ctx: TenantContext,
  returnId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "invoices.manage");
  const parsed = creditSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const ret = await lockReturn(tx, ctx, returnId);
    requireStatus(ret, "POSTED");
    const note = await tx.supplierSettlement.findFirst({
      where: {
        organizationId: ctx.organizationId,
        id: parsed.data.creditNoteId,
        kind: "CREDIT_NOTE",
        status: "POSTED",
        supplierId: ret.supplierId,
        currency: ret.currency,
      },
      select: { id: true, number: true, amount: true, netAmount: true },
    });
    if (!note)
      throw businessRuleViolation(
        "CREDIT_NOTE_MISMATCH",
        "Choose a posted credit note from this supplier in the return's currency",
        { field: "creditNoteId" },
      );
    await tx.supplierReturn.update({
      where: { id: ret.id },
      data: {
        status: "CREDITED",
        creditNoteId: note.id,
        creditedAt: new Date(),
        creditedByUserId: ctx.userId,
      },
    });
    await audit(tx, ctx, ret, "credited", {
      creditNote: note.number,
      expected: dec(ret.totalAmount).toFixed(),
      creditNet: note.netAmount ? dec(note.netAmount).toFixed() : null,
    });
  });
}

// ─── Queries ───

export async function listSupplierReturns(
  ctx: TenantContext,
  filters: { status?: ReturnStatus; supplierId?: string; page?: number } = {},
) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.SupplierReturnWhereInput = {
    organizationId: ctx.organizationId,
    warehouse: warehouseScope(ctx, "purchasing.view"),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.supplierReturn.count({ where }),
      tx.supplierReturn.findMany({
        where,
        select: {
          id: true,
          number: true,
          status: true,
          reason: true,
          currency: true,
          totalAmount: true,
          createdAt: true,
          postedAt: true,
          supplier: { select: { id: true, code: true, name: true, nameAr: true } },
          warehouse: { select: { code: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * RETURN_PAGE_SIZE,
        take: RETURN_PAGE_SIZE,
      }),
    ]);
    return { items, total, page, pageCount: Math.max(1, Math.ceil(total / RETURN_PAGE_SIZE)) };
  });
}

/** The return page: lines, what else could be returned, credit note choices and permissions. */
export async function getSupplierReturn(ctx: TenantContext, returnId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const ret = await lockReturn(tx, ctx, returnId);
    const [lines, supplier, documents, creditNote] = await inSequence([
      tx.supplierReturnLine.findMany({
        where: { organizationId: ctx.organizationId, returnId: ret.id },
        include: {
          product: { select: { id: true, sku: true, nameEn: true, nameAr: true } },
          uom: { select: { code: true } },
          receiptLine: {
            select: {
              lot: { select: { lotCode: true, expiresOn: true } },
              receipt: { select: { id: true, number: true, receivedAt: true } },
            },
          },
        },
        orderBy: { lineNo: "asc" },
      }),
      tx.supplier.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, id: ret.supplierId },
        select: {
          id: true,
          code: true,
          name: true,
          nameAr: true,
          taxId: true,
          address: true,
          phone: true,
          email: true,
        },
      }),
      tx.inventoryDocument.findMany({
        where: {
          organizationId: ctx.organizationId,
          id: {
            in: [ret.inventoryDocumentId, ret.reversalDocumentId].filter((x): x is string => !!x),
          },
        },
        select: { id: true, number: true, type: true },
      }),
      ret.creditNoteId
        ? tx.supplierSettlement.findFirst({
            where: { organizationId: ctx.organizationId, id: ret.creditNoteId },
            select: {
              id: true,
              number: true,
              netAmount: true,
              amount: true,
              supplierDocumentNo: true,
            },
          })
        : Promise.resolve(null),
    ]);
    const canReceive = canOnWarehouse(ctx, "purchasing.receive", ret.warehouse);
    const canCredit = hasPermission(ctx.grants, "invoices.manage");
    const warehouse = await tx.warehouse.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, id: ret.warehouseId },
      select: { id: true, code: true, name: true },
    });
    return {
      ret: { ...ret, warehouse },
      supplier,
      lines,
      documents,
      creditNote,
      returnable: ret.status === "DRAFT" && canReceive ? await returnableInTx(tx, ctx, ret) : [],
      creditNotes:
        ret.status === "POSTED" && canCredit
          ? await tx.supplierSettlement.findMany({
              where: {
                organizationId: ctx.organizationId,
                kind: "CREDIT_NOTE",
                status: "POSTED",
                supplierId: ret.supplierId,
                currency: ret.currency,
              },
              select: {
                id: true,
                number: true,
                netAmount: true,
                date: true,
                supplierDocumentNo: true,
              },
              orderBy: { date: "desc" },
              take: 50,
            })
          : [],
      can: {
        edit: ret.status === "DRAFT" && canReceive,
        post: ret.status === "DRAFT" && canReceive && ret.lines.length > 0,
        cancel: ret.status === "DRAFT" && canReceive,
        reverse: ret.status === "POSTED" && canReceive,
        credit: ret.status === "POSTED" && canCredit,
      },
    };
  });
}

/** Posted receipts a return can start from (the new-return page). */
export async function receiptsToReturnFrom(ctx: TenantContext, supplierId?: string) {
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.goodsReceipt.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: "POSTED",
        warehouse: warehouseScope(ctx, "purchasing.receive"),
        ...(supplierId ? { supplierId } : {}),
      },
      select: {
        id: true,
        number: true,
        receivedAt: true,
        currency: true,
        supplier: { select: { code: true, name: true } },
        warehouse: { select: { code: true } },
      },
      orderBy: { receivedAt: "desc" },
      take: 100,
    }),
  );
}

/** Posted or credited returns against a receipt's lines (a receipt with returns cannot be reversed). */
export async function activeReturnsOnReceipt(tx: Tx, ctx: TenantContext, receiptId: string) {
  return tx.supplierReturn.count({
    where: {
      organizationId: ctx.organizationId,
      status: { in: ["POSTED", "CREDITED"] },
      lines: { some: { receiptLine: { receiptId } } },
    },
  });
}
