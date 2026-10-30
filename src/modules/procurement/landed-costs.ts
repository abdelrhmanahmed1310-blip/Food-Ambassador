import "server-only";
import { Decimal, toDecimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { postLandedCost } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { lockOrder } from "./orders";
import { allocateCharge } from "./rules";
import { landedCostSchema } from "./schemas";

const dec = (v: { toString(): string }) => new Decimal(v.toString());

/**
 * Add a landed cost (freight, duty, insurance, handling, other) to a posted
 * goods receipt (DECISIONS.md ADR-028). The amount is split over the lines
 * that put stock in — by line value at the charged price, or by quantity
 * when all those lines share one base unit — and posted through the
 * inventory module, which adds only the share for stock still on hand.
 * The order row is locked, as for receipts and their reversal.
 */
export async function addReceiptLandedCost(
  ctx: TenantContext,
  receiptId: string,
  rawInput: unknown,
) {
  const parsed = landedCostSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "purchasing.landed_cost", input: { receiptId, ...input } },
    async (tx) => {
      const found = await tx.goodsReceipt.findFirst({
        where: { organizationId: ctx.organizationId, id: receiptId },
        select: { purchaseOrderId: true },
      });
      if (!found) throw notFound("Goods receipt");
      const order = await lockOrder(tx, ctx, found.purchaseOrderId);
      assertPermission(ctx.grants, "inventory.valuation.revalue", {
        branchId: order.warehouse.branchId,
        warehouseId: order.warehouse.id,
      });
      const receipt = await tx.goodsReceipt.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, id: receiptId },
        select: {
          id: true,
          number: true,
          status: true,
          warehouseId: true,
          lines: {
            orderBy: { id: "asc" },
            select: {
              id: true,
              productId: true,
              acceptedQuantity: true,
              acceptedQuantityBase: true,
              unitPrice: true,
              product: { select: { baseUomId: true } },
            },
          },
        },
      });
      if (receipt.status !== "POSTED")
        throw businessRuleViolation("RECEIPT_ALREADY_REVERSED", "This receipt was reversed");
      const lines = receipt.lines.filter((l) => dec(l.acceptedQuantityBase).gt(0));
      if (lines.length === 0)
        throw businessRuleViolation("LANDED_COST_NO_BASIS", "Nothing was put into stock", {
          field: "method",
        });
      if (input.method === "BY_QUANTITY" && new Set(lines.map((l) => l.product.baseUomId)).size > 1)
        throw businessRuleViolation(
          "LANDED_COST_MIXED_UNITS",
          "Lines are in different units; allocate by value",
          { field: "method" },
        );
      const weights = lines.map((l) =>
        input.method === "BY_VALUE"
          ? dec(l.acceptedQuantity).times(dec(l.unitPrice))
          : dec(l.acceptedQuantityBase),
      );
      if (!weights.some((w) => w.gt(0)))
        throw businessRuleViolation(
          "LANDED_COST_NO_BASIS",
          "The received goods have no value; allocate by quantity",
          { field: "method" },
        );
      const amount = toDecimal(input.amount);
      const shares = allocateCharge(amount, weights);
      const today = businessDate(order.warehouse.branch.timeZone ?? ctx.timeZone);
      const result = await postLandedCost(
        tx,
        ctx,
        {
          warehouseId: receipt.warehouseId,
          receiptId: receipt.id,
          chargeType: input.chargeType,
          method: input.method,
          amount,
          reference: input.reference,
          note: input.note,
          lines: lines.map((l, i) => ({
            receiptLineId: l.id,
            productId: l.productId,
            receivedBase: dec(l.acceptedQuantityBase),
            allocated: shares[i],
          })),
        },
        { year: Number(today.slice(0, 4)) },
      );
      return {
        landedCostId: result.landedCostId,
        documentId: result.documentId,
        number: result.number,
        capitalized: result.capitalized,
        expensed: result.expensed,
      };
    },
  );
}
