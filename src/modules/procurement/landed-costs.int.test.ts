import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postWriteOff, reverseDocument } from "@/modules/inventory/operations";
import { reconcileBalances } from "@/modules/inventory/queries";
import { reconcileValuations } from "@/modules/inventory/valuation-queries";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { addReceiptLandedCost } from "./landed-costs";
import { addOrderLine, createOrder, getOrder, submitOrder } from "./orders";
import { getReceipt, postReceipt, reverseReceipt } from "./receipts";
import { createSupplier } from "./suppliers";

let ctx: TenantContext;
let units: Record<string, string>;
let warehouseId: string;
let supplierId: string;
let flour: string; // kg
let sugar: string; // kg
let oil: string; // l

async function valuation(productId: string) {
  const v = await getDb().stockValuation.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, productId, warehouseId },
  });
  return { value: v.totalValue.toFixed(), average: v.averageUnitCost?.toFixed() ?? null };
}

/** Order, approve and receive everything at the order price; returns the receipt id. */
async function received(lines: Array<{ productId: string; quantity: string; unitPrice: string }>) {
  const { id } = await createOrder(ctx, { supplierId, warehouseId });
  for (const l of lines)
    await addOrderLine(ctx, id, {
      ...l,
      uomId: l.productId === oil ? units.l : units.kg,
    });
  await submitOrder(ctx, id);
  const order = await getOrder(ctx, id);
  const receipt = await postReceipt(ctx, id, {
    lines: order.lines.map((l) => ({
      purchaseOrderLineId: l.id,
      receivedQuantity: l.quantity.toString(),
      unitPrice: l.unitPrice.toString(),
    })),
  });
  return receipt.id;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("landed"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (
    await createBranch(ctx, { code: "ALX", name: "Alexandria", type: "RESTAURANT" })
  ).id;
  warehouseId = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" }))
    .id;
  const product = async (sku: string, baseUomId: string) =>
    (await createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId })).id;
  flour = await product("FLOUR", units.kg);
  sugar = await product("SUGAR", units.kg);
  oil = await product("OIL", units.l);
  supplierId = (await createSupplier(ctx, { code: "PORT", name: "Port Traders" })).id;
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
  expect(await reconcileValuations(ctx)).toEqual([]);
  await getDb().$disconnect();
});

describe("landed cost", () => {
  it("allocates by value, capitalizes the share still on hand and expenses the rest", async () => {
    const receiptId = await received([
      { productId: flour, quantity: "100", unitPrice: "10" },
      { productId: sugar, quantity: "50", unitPrice: "20" },
    ]);
    // 20 kg of flour is used before the freight invoice arrives.
    await postWriteOff(ctx, {
      warehouseId,
      productId: flour,
      quantity: "20",
      uomId: units.kg,
      stockStatus: "AVAILABLE",
      reasonCode: "DAMAGED",
    });
    expect(await valuation(flour)).toEqual({ value: "800", average: "10" });

    const finance = await addMember(ctx, "finance");
    const key = "landed-freight-0001";
    const freight = await addReceiptLandedCost(finance.ctx, receiptId, {
      chargeType: "FREIGHT",
      method: "BY_VALUE",
      amount: "200",
      reference: "AWB-778",
      idempotencyKey: key,
    });
    expect(freight).toMatchObject({ capitalized: "180", expensed: "20" });
    expect(freight.number).toMatch(/^LCA-\d{4}-\d{6}$/);
    // Retrying with the same key posts nothing new.
    const again = await addReceiptLandedCost(finance.ctx, receiptId, {
      chargeType: "FREIGHT",
      method: "BY_VALUE",
      amount: "200",
      reference: "AWB-778",
      idempotencyKey: key,
    });
    expect(again.landedCostId).toBe(freight.landedCostId);

    // Flour: 100 of the 200 is for flour, 80 % of it still on hand.
    expect(await valuation(flour)).toEqual({ value: "880", average: "11" });
    expect(await valuation(sugar)).toEqual({ value: "1100", average: "22" });

    // By quantity: 150 kg → 20 for flour (16 on hand), 10 for sugar.
    const duty = await addReceiptLandedCost(ctx, receiptId, {
      chargeType: "CUSTOMS_DUTY",
      method: "BY_QUANTITY",
      amount: "30",
    });
    expect(duty).toMatchObject({ capitalized: "26", expensed: "4" });
    expect(await valuation(flour)).toEqual({ value: "896", average: "11.2" });

    const receipt = await getReceipt(ctx, receiptId);
    expect(receipt.landedCosts).toHaveLength(2);
    expect(receipt.landedCosts[0]).toMatchObject({ chargeType: "FREIGHT", reference: "AWB-778" });
    expect(
      receipt.landedCosts[0].lines
        .reduce((a, l) => a.plus(l.allocatedAmount.toString()), new Decimal(0))
        .toFixed(),
    ).toBe("200");
    expect(receipt.canReverse).toBe(false);

    // The stock's value now includes the charges; neither can be undone by reversal.
    await expectAppError(
      reverseReceipt(ctx, receiptId, { reasonCode: "ENTERED_IN_ERROR" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      reverseDocument(ctx, freight.documentId, { reasonCode: "ENTERED_IN_ERROR" }),
      "BUSINESS_RULE_VIOLATION",
    );
    // Later issues use the new average.
    const wo = await postWriteOff(ctx, {
      warehouseId,
      productId: flour,
      quantity: "10",
      uomId: units.kg,
      stockStatus: "AVAILABLE",
      reasonCode: "DAMAGED",
    });
    expect(wo.documentId).toBeTruthy();
    expect(await valuation(flour)).toEqual({ value: "784", average: "11.2" });
  });

  it("allocates by quantity only within one unit, and needs something to allocate over", async () => {
    const receiptId = await received([
      { productId: flour, quantity: "10", unitPrice: "10" },
      { productId: oil, quantity: "10", unitPrice: "0" },
    ]);
    await expectAppError(
      addReceiptLandedCost(ctx, receiptId, {
        chargeType: "FREIGHT",
        method: "BY_QUANTITY",
        amount: "5",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    // By value the free oil gets nothing.
    await addReceiptLandedCost(ctx, receiptId, {
      chargeType: "HANDLING",
      method: "BY_VALUE",
      amount: "5",
    });
    const free = await received([{ productId: oil, quantity: "4", unitPrice: "0" }]);
    await expectAppError(
      addReceiptLandedCost(ctx, free, { chargeType: "FREIGHT", method: "BY_VALUE", amount: "5" }),
      "BUSINESS_RULE_VIOLATION",
    );
    // A single-unit receipt can be allocated by quantity.
    await addReceiptLandedCost(ctx, free, {
      chargeType: "FREIGHT",
      method: "BY_QUANTITY",
      amount: "2",
    });
    await expectAppError(
      addReceiptLandedCost(ctx, free, { chargeType: "FREIGHT", method: "BY_VALUE", amount: "0" }),
      "VALIDATION_FAILED",
    );
  });

  it("refuses reversed receipts, users without revalue permission and other tenants", async () => {
    const receiptId = await received([{ productId: sugar, quantity: "5", unitPrice: "20" }]);
    const procurement = await addMember(ctx, "procurement");
    await expectAppError(
      addReceiptLandedCost(procurement.ctx, receiptId, {
        chargeType: "FREIGHT",
        method: "BY_VALUE",
        amount: "5",
      }),
      "FORBIDDEN",
    );
    const other = await createTenant("landed-other");
    await expectAppError(
      addReceiptLandedCost(other.ctx, receiptId, {
        chargeType: "FREIGHT",
        method: "BY_VALUE",
        amount: "5",
      }),
      "NOT_FOUND",
    );
    await reverseReceipt(ctx, receiptId, { reasonCode: "ENTERED_IN_ERROR" });
    await expectAppError(
      addReceiptLandedCost(ctx, receiptId, {
        chargeType: "FREIGHT",
        method: "BY_VALUE",
        amount: "5",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await getReceipt(ctx, receiptId)).canAddLandedCost).toBe(false);
  });
});
