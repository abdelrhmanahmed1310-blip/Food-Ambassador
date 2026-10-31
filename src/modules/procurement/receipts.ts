import "server-only";
import { emitEvent } from "@/modules/integrations/service";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal, toDecimal } from "@/lib/decimal";
import { uuidv7 } from "@/lib/uuid";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { findProduct, quantityInBaseUnit } from "@/modules/catalog/service";
import {
  postReceiptInTx,
  reverseDocumentInTx,
  type ReceiptPostingLine,
} from "@/modules/inventory/operations";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import { reversalSchema } from "@/modules/inventory/schemas";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { canOnWarehouse, lockOrder, warehouseScope } from "./orders";
import { isReceivable, maxAcceptable, statusFromReceipts } from "./rules";
import { receiptSchema } from "./schemas";
import { loadRules } from "./settings";

export const RECEIPT_PAGE_SIZE = 25;
const dec = (v: { toString(): string }) => new Decimal(v.toString());

/**
 * Receive a delivery against an approved order (DECISIONS.md ADR-023).
 *
 * Per line: received = accepted + rejected. Accepted stock is posted to the
 * ledger at the price charged (AVAILABLE, or QUARANTINE for inspection);
 * rejected goods are recorded with a reason and never enter stock. Accepted
 * quantity may exceed what is still open only within the organization's
 * over-receipt tolerance. The order row is locked, so concurrent receipts
 * against one order are applied one after the other and cannot over-receive.
 */
export async function postReceipt(ctx: TenantContext, orderId: string, rawInput: unknown) {
  const parsed = receiptSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "goods_receipt.post", input: { orderId, ...input } },
    async (tx) => {
      const order = await lockOrder(tx, ctx, orderId);
      assertPermission(ctx.grants, "purchasing.receive", {
        branchId: order.warehouse.branchId,
        warehouseId: order.warehouse.id,
      });
      if (!isReceivable(order.status))
        throw businessRuleViolation(
          "ORDER_NOT_RECEIVABLE",
          "Only approved orders can be received",
          {
            status: order.status,
          },
        );
      const rules = await loadRules(tx, ctx);
      const today = businessDate(order.warehouse.branch.timeZone ?? ctx.timeZone);
      const receiptId = uuidv7();
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "GRN",
        Number(today.slice(0, 4)),
      );

      const seen = new Set<string>();
      const lines: Array<{
        id: string;
        formIndex: number;
        orderLine: (typeof order.lines)[number];
        received: Decimal;
        accepted: Decimal;
        rejected: Decimal;
        acceptedBase: Decimal;
        rejectedBase: Decimal;
        input: (typeof input.lines)[number];
      }> = [];
      for (const [formIndex, l] of input.lines.entries()) {
        const received = toDecimal(l.receivedQuantity);
        if (received.isZero()) continue;
        const orderLine = order.lines.find((o) => o.id === l.purchaseOrderLineId);
        if (!orderLine) throw notFound("Order line");
        if (seen.has(orderLine.id))
          throw businessRuleViolation("DUPLICATE_RECEIPT_LINE", "A line was entered twice");
        seen.add(orderLine.id);
        const rejected = toDecimal(l.rejectedQuantity);
        const accepted = received.minus(rejected);
        assertPermission(ctx.grants, "catalog.view");
        const product = await findProduct(tx, ctx, orderLine.productId);
        const base = (q: Decimal) =>
          q.isZero()
            ? Promise.resolve(new Decimal(0))
            : quantityInBaseUnit(tx, ctx, product, orderLine.uomId, q.toFixed());
        const acceptedBase = await base(accepted);
        const rejectedBase = await base(rejected);
        const limit = maxAcceptable(dec(orderLine.quantityBase), rules.overReceiptTolerance);
        const after = dec(orderLine.receivedQuantityBase).plus(acceptedBase);
        if (after.greaterThan(limit)) {
          // Express the limit in the order line's unit for the message.
          const perUnit = dec(orderLine.quantityBase).dividedBy(dec(orderLine.quantity));
          const remaining = Decimal.max(limit.minus(dec(orderLine.receivedQuantityBase)), 0)
            .dividedBy(perUnit)
            .toDecimalPlaces(6, Decimal.ROUND_DOWN);
          throw businessRuleViolation("OVER_RECEIPT", "More than ordered (beyond tolerance)", {
            field: `lines.${formIndex}.receivedQuantity`,
            maximum: remaining.toFixed(),
          });
        }
        if (
          accepted.gt(0) &&
          l.temperatureCelsius === undefined &&
          product.storageRequirement !== "AMBIENT"
        )
          throw businessRuleViolation(
            "TEMPERATURE_REQUIRED",
            "Record the temperature of chilled or frozen goods",
            {
              field: `lines.${formIndex}.temperatureCelsius`,
            },
          );
        lines.push({
          id: uuidv7(),
          formIndex,
          orderLine,
          received,
          accepted,
          rejected,
          acceptedBase,
          rejectedBase,
          input: l,
        });
      }
      if (lines.length === 0)
        throw businessRuleViolation(
          "NOTHING_RECEIVED",
          "Enter the quantity received for at least one line",
        );

      if (input.locationId) {
        const location = await tx.storageLocation.findFirst({
          where: {
            organizationId: ctx.organizationId,
            warehouseId: order.warehouseId,
            id: input.locationId,
            archivedAt: null,
          },
        });
        if (!location) throw notFound("Location");
      }
      const receivedAt = new Date();
      await tx.goodsReceipt.create({
        data: {
          id: receiptId,
          organizationId: ctx.organizationId,
          number,
          purchaseOrderId: order.id,
          supplierId: order.supplierId,
          warehouseId: order.warehouseId,
          locationId: input.locationId ?? null,
          deliveryNoteRef: input.deliveryNoteRef,
          note: input.note,
          receivedAt,
          postedByUserId: ctx.userId,
        },
      });

      // Stock: accepted quantities only, through the inventory module.
      const acceptedLines = lines.filter((l) => l.accepted.gt(0));
      let documentId: string | null = null;
      const lotByLine = new Map<string, string | null>();
      if (acceptedLines.length > 0) {
        const posting = await postReceiptInTx(tx, ctx, {
          warehouseId: order.warehouseId,
          locationId: input.locationId ?? null,
          receiptNumber: number,
          note: input.note,
          lines: acceptedLines.map((l): ReceiptPostingLine => ({
            formIndex: l.formIndex,
            sourceLineId: l.id,
            productId: l.orderLine.productId,
            uomId: l.orderLine.uomId,
            quantity: l.accepted.toFixed(),
            unitPrice: l.input.unitPrice,
            lotCode: l.input.lotCode,
            expiresOn: l.input.expiresOn,
            quarantine: l.input.quarantine,
          })),
        });
        documentId = posting.documentId;
        acceptedLines.forEach((l, i) => lotByLine.set(l.id, posting.lines[i].lotId));
      }

      await tx.goodsReceiptLine.createMany({
        data: lines.map((l) => ({
          id: l.id,
          organizationId: ctx.organizationId,
          receiptId,
          purchaseOrderLineId: l.orderLine.id,
          productId: l.orderLine.productId,
          uomId: l.orderLine.uomId,
          receivedQuantity: l.received.toFixed(),
          acceptedQuantity: l.accepted.toFixed(),
          rejectedQuantity: l.rejected.toFixed(),
          acceptedQuantityBase: l.acceptedBase.toFixed(),
          rejectedQuantityBase: l.rejectedBase.toFixed(),
          rejectionReason: l.rejected.gt(0) ? (l.input.rejectionReason ?? null) : null,
          quarantine: l.accepted.gt(0) && l.input.quarantine,
          lotId: lotByLine.get(l.id) ?? null,
          unitPrice: l.input.unitPrice,
          orderedUnitPrice: dec(l.orderLine.unitPrice).toFixed(),
          temperatureCelsius: l.input.temperatureCelsius ?? null,
        })),
      });
      if (documentId)
        await tx.goodsReceipt.update({
          where: { id: receiptId },
          data: { inventoryDocumentId: documentId },
        });

      // Order progress and the supplier's last price, under the order lock.
      const receivedByLine = new Map(lines.map((l) => [l.orderLine.id, l.acceptedBase]));
      for (const l of order.lines) {
        const add = receivedByLine.get(l.id);
        if (!add || add.isZero()) continue;
        await tx.purchaseOrderLine.update({
          where: { id: l.id },
          data: { receivedQuantityBase: dec(l.receivedQuantityBase).plus(add).toFixed() },
        });
      }
      const status = statusFromReceipts(
        order.lines.map((l) => ({
          orderedBase: dec(l.quantityBase),
          receivedBase: dec(l.receivedQuantityBase).plus(receivedByLine.get(l.id) ?? 0),
        })),
      );
      await tx.purchaseOrder.update({ where: { id: order.id }, data: { status } });
      for (const l of acceptedLines) {
        const key = {
          organizationId: ctx.organizationId,
          supplierId: order.supplierId,
          productId: l.orderLine.productId,
        };
        const link = await tx.supplierProduct.findUnique({
          where: { organizationId_supplierId_productId: key },
          select: { id: true, purchaseUomId: true },
        });
        if (!link) {
          await tx.supplierProduct.create({
            data: {
              ...key,
              purchaseUomId: l.orderLine.uomId,
              lastUnitPrice: l.input.unitPrice,
              lastPriceAt: receivedAt,
            },
          });
        } else if (link.purchaseUomId === l.orderLine.uomId) {
          // The price is per the order line's unit; a price in another unit is not comparable.
          await tx.supplierProduct.update({
            where: { id: link.id },
            data: { lastUnitPrice: l.input.unitPrice, lastPriceAt: receivedAt },
          });
        }
      }
      await recordAudit(tx, actorOf(ctx), {
        action: "goods_receipt.posted",
        entityType: "goods_receipt",
        entityId: receiptId,
        changes: {
          number,
          order: order.number,
          lines: lines.length,
          rejectedLines: lines.filter((l) => l.rejected.gt(0)).length,
          orderStatus: status,
        },
      });
      await emitEvent(tx, ctx, "goods_receipt.posted", receiptId, {
        receiptId,
        number,
        orderId: order.id,
        orderNumber: order.number,
        lines: lines.length,
      });
      return { id: receiptId, number, orderStatus: status };
    },
  );
}

/**
 * Reverse a posted receipt: the stock it added is taken back out (at the
 * value it added, ADR-021) and the order's received quantities are reduced.
 * Fails if the stock has already been used, or if the order was closed.
 */
export async function reverseReceipt(ctx: TenantContext, receiptId: string, rawInput: unknown) {
  const parsed = reversalSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const found = await tx.goodsReceipt.findFirst({
      where: { organizationId: ctx.organizationId, id: receiptId },
      select: { purchaseOrderId: true },
    });
    if (!found) throw notFound("Goods receipt");
    const order = await lockOrder(tx, ctx, found.purchaseOrderId);
    const receipt = await tx.goodsReceipt.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, id: receiptId },
      include: { lines: true, _count: { select: { landedCosts: true } } },
    });
    assertPermission(ctx.grants, "purchasing.manage", {
      branchId: order.warehouse.branchId,
      warehouseId: order.warehouse.id,
    });
    if (receipt.status !== "POSTED")
      throw businessRuleViolation("RECEIPT_ALREADY_REVERSED", "This receipt was already reversed");
    // Its landed costs are now part of the stock's value (ADR-028).
    if (receipt._count.landedCosts > 0)
      throw businessRuleViolation(
        "RECEIPT_HAS_LANDED_COST",
        "The receipt has landed costs; correct the stock with an adjustment instead",
      );
    if (order.status === "CLOSED" || order.status === "CANCELLED")
      throw businessRuleViolation(
        "RECEIPT_ORDER_CLOSED",
        "The order is closed; correct the stock with an adjustment instead",
      );
    let reversalDocumentId: string | null = null;
    if (receipt.inventoryDocumentId) {
      const reversal = await reverseDocumentInTx(
        tx,
        ctx,
        receipt.inventoryDocumentId,
        parsed.data,
        { allowReceipt: true, permission: "purchasing.manage" },
      );
      reversalDocumentId = reversal.documentId;
    }
    const removedByLine = new Map<string, Decimal>();
    for (const l of receipt.lines)
      removedByLine.set(
        l.purchaseOrderLineId,
        (removedByLine.get(l.purchaseOrderLineId) ?? new Decimal(0)).plus(
          dec(l.acceptedQuantityBase),
        ),
      );
    for (const l of order.lines) {
      const remove = removedByLine.get(l.id);
      if (!remove || remove.isZero()) continue;
      await tx.purchaseOrderLine.update({
        where: { id: l.id },
        data: {
          receivedQuantityBase: Decimal.max(dec(l.receivedQuantityBase).minus(remove), 0).toFixed(),
        },
      });
    }
    const status = statusFromReceipts(
      order.lines.map((l) => ({
        orderedBase: dec(l.quantityBase),
        receivedBase: Decimal.max(
          dec(l.receivedQuantityBase).minus(removedByLine.get(l.id) ?? 0),
          0,
        ),
      })),
    );
    await tx.purchaseOrder.update({ where: { id: order.id }, data: { status } });
    await tx.goodsReceipt.update({
      where: { id: receipt.id },
      data: {
        status: "REVERSED",
        reversedAt: new Date(),
        reversedByUserId: ctx.userId,
        reversalReason: parsed.data.note
          ? `${parsed.data.reasonCode}: ${parsed.data.note}`
          : parsed.data.reasonCode,
        reversalDocumentId,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "goods_receipt.reversed",
      entityType: "goods_receipt",
      entityId: receipt.id,
      changes: { number: receipt.number, order: order.number, reason: parsed.data.reasonCode },
    });
    return { orderStatus: status };
  });
}

// ─── Queries ───

export async function listReceipts(
  ctx: TenantContext,
  filters: { supplierId?: string; orderId?: string; page?: number } = {},
) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.GoodsReceiptWhereInput = {
    organizationId: ctx.organizationId,
    warehouse: warehouseScope(ctx, "purchasing.view"),
    ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
    ...(filters.orderId ? { purchaseOrderId: filters.orderId } : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.goodsReceipt.count({ where }),
      tx.goodsReceipt.findMany({
        where,
        select: {
          id: true,
          number: true,
          status: true,
          receivedAt: true,
          deliveryNoteRef: true,
          purchaseOrder: { select: { id: true, number: true } },
          supplier: { select: { id: true, code: true, name: true, nameAr: true } },
          warehouse: { select: { code: true } },
          _count: { select: { lines: true } },
        },
        orderBy: { receivedAt: "desc" },
        skip: (page - 1) * RECEIPT_PAGE_SIZE,
        take: RECEIPT_PAGE_SIZE,
      }),
    ]);
    return { items, total, page, pageCount: Math.max(1, Math.ceil(total / RECEIPT_PAGE_SIZE)) };
  });
}

export async function getReceipt(ctx: TenantContext, receiptId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const receipt = await tx.goodsReceipt.findFirst({
      where: { organizationId: ctx.organizationId, id: receiptId },
      include: {
        purchaseOrder: { select: { id: true, number: true, status: true } },
        supplier: { select: { id: true, code: true, name: true, nameAr: true } },
        warehouse: {
          select: {
            id: true,
            code: true,
            name: true,
            branchId: true,
            archivedAt: true,
            branch: { select: { timeZone: true, archivedAt: true } },
          },
        },
        location: { select: { code: true } },
        document: { select: { id: true, number: true } },
        reversal: { select: { id: true, number: true } },
        landedCosts: {
          orderBy: { postedAt: "asc" },
          include: {
            document: { select: { id: true, number: true } },
            lines: {
              select: { receiptLineId: true, allocatedAmount: true, capitalizedAmount: true },
            },
          },
        },
        lines: {
          orderBy: { id: "asc" },
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
            uom: { select: { code: true } },
            lot: { select: { lotCode: true, expiresOn: true } },
          },
        },
      },
    });
    if (!receipt || !canOnWarehouse(ctx, "purchasing.view", receipt.warehouse))
      throw notFound("Goods receipt");
    const users = await tx.user.findMany({
      where: {
        id: {
          in: [receipt.postedByUserId, receipt.reversedByUserId].filter((v): v is string => !!v),
        },
      },
      select: { id: true, name: true },
    });
    const name = (id: string | null) =>
      id ? (users.find((u) => u.id === id)?.name ?? null) : null;
    return {
      ...receipt,
      names: { postedBy: name(receipt.postedByUserId), reversedBy: name(receipt.reversedByUserId) },
      canAddLandedCost:
        receipt.status === "POSTED" &&
        receipt.inventoryDocumentId !== null &&
        canOnWarehouse(ctx, "inventory.valuation.revalue", receipt.warehouse),
      canReverse:
        receipt.landedCosts.length === 0 &&
        receipt.status === "POSTED" &&
        receipt.purchaseOrder.status !== "CLOSED" &&
        receipt.purchaseOrder.status !== "CANCELLED" &&
        canOnWarehouse(ctx, "purchasing.manage", receipt.warehouse),
    };
  });
}
