import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { createRegister, getOrder, getShift, openShift, refundOrder, submitOrder } from "./service";
import { importSettlement, reconciliation } from "./settlements";

let ctx: TenantContext;
let register: string;
let shiftId: string;
let item: string;
let today: string;
const orders: Record<string, string> = {};

const sell = (payments: unknown[]) =>
  submitOrder(ctx, {
    orderId: randomUUID(),
    registerId: register,
    channel: "TAKEAWAY",
    lines: [{ itemId: item, quantity: "1", optionIds: [] }],
    payments,
  });

beforeAll(async () => {
  ({ ctx } = await createTenant("payments"));
  today = businessDate(ctx.timeZone);
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  const wh = (
    await createWarehouse(ctx, { branchId, code: "K", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const p = (
    await createProduct(ctx, {
      sku: "MEAL",
      nameEn: "Meal",
      type: "FINISHED_GOOD",
      baseUomId: units.each,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: wh,
    productId: p,
    quantity: "100",
    uomId: units.each,
    unitCost: "10",
  });
  const cat = (await createMenuCategory(ctx, { name: "Meals" })).id;
  item = (
    await createMenuItem(ctx, {
      code: "MEAL",
      name: "Meal",
      categoryId: cat,
      kind: "ITEM",
      productId: p,
    })
  ).id;
  await addMenuItemPrice(ctx, item, { channel: "TAKEAWAY", price: "100", effectiveFrom: today });
  register = (await createRegister(ctx, { branchId, warehouseId: wh, code: "T1", name: "Till" }))
    .id;
  shiftId = (await openShift(ctx, register, { openingFloat: "0" })).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("card payments (ADR-065)", () => {
  it("records card details and tips, never on cash, never more than 4 digits", async () => {
    orders.a = (
      await sell([
        {
          method: "CARD",
          amount: "100",
          tip: "10",
          cardScheme: "MADA",
          terminalId: "T1",
          approvalCode: "A1",
          cardLast4: "4242",
        },
      ])
    ).id;
    orders.b = (
      await sell([{ method: "CARD", amount: "100", cardScheme: "VISA", approvalCode: "B2" }])
    ).id;
    orders.c = (await sell([{ method: "CARD", amount: "100", approvalCode: "C3" }])).id;
    await expectAppError(
      sell([{ method: "CASH", amount: "100", approvalCode: "X1" }]),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      sell([{ method: "CASH", amount: "100", tip: "5" }]),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      sell([{ method: "CARD", amount: "100", cardLast4: "4242424242424242" }]),
      "VALIDATION_FAILED",
    );
    const order = await getOrder(ctx, orders.a);
    expect(order.payments[0]).toMatchObject({
      cardScheme: "MADA",
      approvalCode: "A1",
      cardLast4: "4242",
    });
    expect(order.payments[0].tip.toFixed()).toBe("10");
    expect(order.grossAmount.toFixed()).toBe("100"); // the tip is not a sale
    // The database refuses a full card number even if the service were bypassed.
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.posPayment.create({
          data: {
            organizationId: ctx.organizationId,
            orderId: orders.a,
            method: "CARD",
            amount: "1",
            cardLast4: "4242424242424242",
          },
        }),
      ),
    ).rejects.toThrow();
    expect((await getShift(ctx, shiftId)).totals.tips.toFixed()).toBe("10");
    const refund = await refundOrder(ctx, orders.c, {
      registerId: register,
      method: "CARD",
      reference: "RF778",
      reason: "Cold",
      lines: [{ orderLineId: (await getOrder(ctx, orders.c)).lines[0].id, quantity: "1" }],
    });
    expect(
      (await getDb().posRefund.findUniqueOrThrow({ where: { id: refund.id } })).reference,
    ).toBe("RF778");
  });
});

describe("settlement reconciliation", () => {
  it("matches the acquirer's file to card payments and reports the gaps", async () => {
    const csv = [
      "date,terminal_id,approval_code,amount,fee",
      `${today},T1,A1,110.00,1.65`, // sale 100 + tip 10
      `${today},,B2,95.00,1.50`, // wrong amount
      `${today},T1,Z9,50.00,0.75`, // no such sale
    ].join("\n");
    const cashier = (await addMember(ctx, "cashier")).ctx;
    await expectAppError(importSettlement(cashier, { fileName: "s.csv", text: csv }), "FORBIDDEN");
    await expectAppError(
      importSettlement(ctx, { fileName: "bad.csv", text: "date,amount\n2026-01-01,5" }),
      "BUSINESS_RULE_VIOLATION",
    );
    const r = await importSettlement(ctx, { fileName: "acquirer-2026-11-01.csv", text: csv });
    expect(r).toMatchObject({ lines: 3, matched: 1, mismatched: 1, unmatched: 1 });
    await expectAppError(importSettlement(ctx, { fileName: "again.csv", text: csv }), "CONFLICT");

    const rec = await reconciliation(ctx, { from: today, to: today }, today);
    expect(rec.cardSales.toFixed()).toBe("310"); // 110 + 100 + 100
    expect(rec.tips.toFixed()).toBe("10");
    expect(rec.settled.toFixed()).toBe("205"); // matched 110 + mismatched 95
    expect(rec.fees.toFixed()).toBe("3.9");
    expect(rec.matched).toBe(1);
    expect(rec.mismatched.map((l) => l.payment?.order.id)).toEqual([orders.b]);
    expect(rec.unmatched.map((l) => l.approvalCode)).toEqual(["Z9"]);
    expect(rec.unsettled.map((p) => p.order.id)).toEqual([orders.c]);
    expect(rec.unsettled[0].overdue).toBe(false);
    // Paid out once: the same approval code in a later file stays unmatched.
    const later = await importSettlement(ctx, {
      fileName: "next.csv",
      text: `date,approval_code,amount\n${today},A1,110`,
    });
    expect(later).toMatchObject({ matched: 0, unmatched: 1 });
    const other = (await createTenant("payments-other")).ctx;
    expect((await reconciliation(other, { from: today, to: today }, today)).batches).toHaveLength(
      0,
    );
  });
});
