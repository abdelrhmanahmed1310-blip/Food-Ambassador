import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  adjustPoints,
  createCustomer,
  eraseCustomer,
  findCustomerByPhone,
  getCustomer,
  listCustomers,
  saveLoyaltySettings,
} from "./customers";
import { blockGiftCard, giftCardBalance, listGiftCards, sellGiftCard } from "./gift-cards";
import { addTabLines, createFloor, openTab, payTab } from "./tables";
import {
  createRegister,
  getOrder,
  getShift,
  openShift,
  refundOrder,
  submitOrder,
  voidOrder,
} from "./service";

/** Customers, loyalty points and gift cards (ADR-068). Prices include 15 % VAT. */

let ctx: TenantContext;
let other: TenantContext;
let cashier: TenantContext;
let branchId: string;
let register: string;
let shiftId: string;
let fries: string;
let cola: string;
let customerId: string;
let kitchenId: string;

const TZ = "Asia/Riyadh";
const card = (amount: string) => [{ method: "CARD" as const, amount }];
const order = (lines: Array<{ itemId: string; quantity?: string }>, extra = {}) => ({
  orderId: randomUUID(),
  registerId: register,
  channel: "DINE_IN" as const,
  lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity ?? "1" })),
  ...extra,
});
const balanceOf = async (id: string) =>
  (await getDb().posCustomer.findUniqueOrThrow({ where: { id } })).pointsBalance;

beforeAll(async () => {
  ({ ctx } = await createTenant("customers", { baseCurrency: "SAR", timeZone: TZ }));
  ({ ctx: other } = await createTenant("customers-other", { baseCurrency: "SAR", timeZone: TZ }));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  await applyCountryPreset(ctx, "SA");
  const codes = Object.fromEntries((await getTaxSetup(ctx)).codes.map((c) => [c.code, c.id]));
  await updateTaxSettings(ctx, {
    country: "SA",
    vatRegistered: "on",
    pricesIncludeTax: "on",
    vatNumber: "310122393500003",
    defaultSalesTaxCodeId: codes.STD,
    defaultPurchaseTaxCodeId: codes.STD,
  });
  branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" })).id;
  const kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  kitchenId = kitchen;
  const product = async (sku: string) => {
    const id = (
      await createProduct(ctx, { sku, nameEn: sku, type: "FINISHED_GOOD", baseUomId: units.each })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId: kitchen,
      productId: id,
      quantity: "100",
      uomId: units.each,
      unitCost: "2",
    });
    return id;
  };
  const today = businessDate(TZ);
  const menu = (await createMenuCategory(ctx, { name: "Menu" })).id;
  fries = (
    await createMenuItem(ctx, {
      code: "FRIES",
      name: "Fries",
      categoryId: menu,
      kind: "ITEM",
      productId: await product("FRIES"),
    })
  ).id;
  cola = (
    await createMenuItem(ctx, {
      code: "COLA",
      name: "Cola",
      categoryId: menu,
      kind: "ITEM",
      productId: await product("COLA"),
    })
  ).id;
  await addMenuItemPrice(ctx, fries, { channel: "DINE_IN", price: "23", effectiveFrom: today });
  await addMenuItemPrice(ctx, cola, { channel: "DINE_IN", price: "11.5", effectiveFrom: today });
  register = (
    await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL1", name: "Till" })
  ).id;
  shiftId = (await openShift(ctx, register, { openingFloat: "100" })).id;
  cashier = (await addMember(ctx, "cashier", { scopeType: "BRANCH", branchId })).ctx;
  // 1 point per riyal paid; a point is worth 5 halalas; spend at least 20.
  await saveLoyaltySettings(ctx, {
    enabled: "on",
    earnRate: "1",
    pointValue: "0.05",
    minRedeemPoints: "20",
  });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("customers (ADR-068)", () => {
  it("a cashier adds a customer at the till and finds them by phone", async () => {
    const c = await createCustomer(cashier, {
      name: "Sara",
      phone: "050 123 4567",
      marketingConsent: "on",
    });
    customerId = c.id;
    expect(await findCustomerByPhone(cashier, "+966501234567")).toEqual({
      id: c.id,
      name: "Sara",
      points: 0,
    });
    await expectAppError(
      createCustomer(cashier, { name: "Again", phone: "0501234567" }),
      "CONFLICT",
    );
    await expectAppError(
      createCustomer(cashier, { name: "Bad", phone: "123" }),
      "VALIDATION_FAILED",
    );
    const row = await getDb().posCustomer.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.consentAt).not.toBeNull();
    // The customer list and changes are for managers.
    await expectAppError(listCustomers(cashier), "FORBIDDEN");
    await expectAppError(adjustPoints(cashier, c.id, { points: "10", reason: "x" }), "FORBIDDEN");
    expect((await listCustomers(ctx, { q: "0501" })).rows.map((r) => r.name)).toEqual(["Sara"]);
  });
});

describe("loyalty points", () => {
  it("earns on what was paid and spends points as the order discount", async () => {
    const first = await submitOrder(cashier, {
      ...order([{ itemId: cola }]),
      customerId,
      payments: card("11.5"),
      expectedTotal: "11.5",
    });
    expect((await getOrder(ctx, first.id)).pointsEarned).toBe(11);
    await adjustPoints(ctx, customerId, { points: "200", reason: "Welcome gift" });
    expect(await balanceOf(customerId)).toBe(211);

    // 100 points = 5.00 off: fries 23 → 18 paid, 18 points earned.
    const spend = await submitOrder(cashier, {
      ...order([{ itemId: fries }]),
      customerId,
      loyaltyPoints: 100,
      payments: card("18"),
      expectedTotal: "18",
    });
    const o = await getOrder(ctx, spend.id);
    expect(o.orderDiscount.toFixed(2)).toBe("5.00");
    expect(o.loyaltyPoints).toBe(100);
    expect(o.taxAmount.toFixed(2)).toBe("2.35");
    expect(await balanceOf(customerId)).toBe(129);

    // Voiding it gives the 100 points back and takes the 18 earned.
    await voidOrder(ctx, spend.id, { reason: "Wrong table" });
    expect(await balanceOf(customerId)).toBe(211);
  });

  it("refuses too few, too many, or points worth more than the order", async () => {
    const attempt = (points: number, items = [{ itemId: cola }]) =>
      submitOrder(cashier, {
        ...order(items),
        customerId,
        loyaltyPoints: points,
        payments: card("1"),
      });
    await expectAppError(attempt(10), "BUSINESS_RULE_VIOLATION");
    await expectAppError(attempt(5000), "BUSINESS_RULE_VIOLATION");
    // 211 points = 10.55 is less than cola 11.5, but 300 would be more: adjust and try.
    await adjustPoints(ctx, customerId, { points: "100", reason: "Test" });
    await expectAppError(attempt(300), "BUSINESS_RULE_VIOLATION");
    await adjustPoints(ctx, customerId, { points: "-100", reason: "Test" });
    await expectAppError(
      submitOrder(cashier, {
        ...order([{ itemId: cola }]),
        loyaltyPoints: 20,
        payments: card("10.5"),
      }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      adjustPoints(ctx, customerId, { points: "-5000", reason: "Too many" }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("takes back the refunded share of points", async () => {
    const o = await submitOrder(cashier, {
      ...order([{ itemId: cola, quantity: "2" }]),
      customerId,
      payments: card("23"),
    });
    expect(await balanceOf(customerId)).toBe(234);
    const full = await getOrder(ctx, o.id);
    await refundOrder(ctx, o.id, {
      registerId: register,
      method: "CARD",
      reason: "Flat",
      lines: [{ orderLineId: full.lines[0].id, quantity: "1" }],
    });
    expect(await balanceOf(customerId)).toBe(223);
  });

  it("keeps the ledger equal to the balance", async () => {
    const entries = await getDb().loyaltyEntry.aggregate({
      where: { organizationId: ctx.organizationId, customerId },
      _sum: { points: true },
    });
    expect(entries._sum.points).toBe(await balanceOf(customerId));
    const c = await getCustomer(ctx, customerId);
    expect(c.orders.length).toBeGreaterThanOrEqual(3);
    expect(c.entries.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["EARN", "REDEEM", "REVERSAL", "ADJUSTMENT"]),
    );
  });
});

describe("gift cards", () => {
  let code: string;

  it("is sold in the shift, kept as a hash, and pays for orders", async () => {
    const sold = await sellGiftCard(cashier, {
      registerId: register,
      amount: "50",
      method: "CASH",
    });
    code = sold.code;
    expect(code).toMatch(/^\d{16}$/);
    const row = await getDb().giftCard.findUniqueOrThrow({ where: { id: sold.id } });
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row.last4).toBe(code.slice(-4));
    expect(await giftCardBalance(cashier, code)).toEqual({
      last4: code.slice(-4),
      balance: "50",
      blocked: false,
    });

    const o = await submitOrder(cashier, {
      ...order([{ itemId: fries }]),
      payments: [{ method: "GIFT_CARD", amount: "23", giftCardCode: code }],
      expectedTotal: "23",
    });
    expect((await giftCardBalance(cashier, code)).balance).toBe("27");
    expect((await getOrder(ctx, o.id)).payments[0].giftCard?.last4).toBe(code.slice(-4));

    // More than is left is refused; the rest can be paid another way.
    await expectAppError(
      submitOrder(cashier, {
        ...order([{ itemId: fries, quantity: "2" }]),
        payments: [{ method: "GIFT_CARD", amount: "46", giftCardCode: code }],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    const split = await submitOrder(cashier, {
      ...order([{ itemId: fries, quantity: "2" }]),
      payments: [
        { method: "GIFT_CARD", amount: "27", giftCardCode: code },
        { method: "CASH", amount: "19", tendered: "20" },
      ],
    });
    expect((await giftCardBalance(cashier, code)).balance).toBe("0");
    // A void puts the money back on the card.
    await voidOrder(ctx, split.id, { reason: "Changed mind" });
    expect((await giftCardBalance(cashier, code)).balance).toBe("27");
  });

  it("refuses a mistyped, unknown or blocked card", async () => {
    const pay = (giftCardCode: string) =>
      submitOrder(cashier, {
        ...order([{ itemId: cola }]),
        payments: [{ method: "GIFT_CARD", amount: "11.5", giftCardCode }],
      });
    const typo = code.slice(0, 15) + String((Number(code[15]) + 1) % 10);
    await expectAppError(pay(typo), "BUSINESS_RULE_VIOLATION");
    await expectAppError(giftCardBalance(cashier, typo), "VALIDATION_FAILED");
    await expectAppError(
      submitOrder(cashier, {
        ...order([{ itemId: cola }]),
        payments: [{ method: "GIFT_CARD", amount: "11.5" }],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    const { cards, owed } = await listGiftCards(ctx);
    // Owed per currency (ADR-086): one currency here.
    expect(owed.map((o) => [o.currency, o.amount.toFixed(2)])).toEqual([
      [ctx.baseCurrency, "27.00"],
    ]);
    await expectAppError(blockGiftCard(cashier, cards[0].id), "FORBIDDEN");
    await blockGiftCard(ctx, cards[0].id);
    await expectAppError(pay(code), "BUSINESS_RULE_VIOLATION");
  });

  it("counts the cash taken for gift cards in the shift, not as sales", async () => {
    const shift = await getShift(ctx, shiftId);
    expect(shift.totals.giftCards.soldCash.toFixed(2)).toBe("50.00");
    expect(shift.totals.giftCards.redeemed.toFixed(2)).toBe("23.00");
    // Float 100 + gift card 50 + the 19 cash of the voided order (not counted).
    expect(shift.totals.expectedCash.toFixed(2)).toBe("150.00");
  });
});

describe("privacy and tenant isolation", () => {
  it("erases a customer's personal data and keeps the history", async () => {
    await eraseCustomer(ctx, customerId);
    const row = await getDb().posCustomer.findUniqueOrThrow({ where: { id: customerId } });
    expect([row.name, row.phone, row.email, row.marketingConsent, row.pointsBalance]).toEqual([
      "—",
      null,
      null,
      false,
      0,
    ]);
    await expectAppError(findCustomerByPhone(cashier, "0501234567"), "NOT_FOUND");
    expect(
      await getDb().posOrder.count({ where: { organizationId: ctx.organizationId, customerId } }),
    ).toBeGreaterThan(0);
    // The number can be used again by a new customer.
    await createCustomer(cashier, { name: "New Sara", phone: "0501234567" });
  });

  it("keeps customers and gift cards to their organization", async () => {
    const theirs = await createCustomer(other, { name: "Omar", phone: "0559876543" });
    await expectAppError(findCustomerByPhone(ctx, "0559876543"), "NOT_FOUND");
    await expectAppError(getCustomer(ctx, theirs.id), "NOT_FOUND");
    await expectAppError(adjustPoints(ctx, theirs.id, { points: "5", reason: "x" }), "NOT_FOUND");
    const sold = await sellGiftCard(ctx, { registerId: register, amount: "10", method: "CARD" });
    await expectAppError(giftCardBalance(other, sold.code), "NOT_FOUND");
    await expectAppError(
      sellGiftCard(other, { registerId: register, amount: "10", method: "CASH" }),
      "NOT_FOUND",
    );
    // Another organization's customer cannot be put on an order.
    await expectAppError(
      submitOrder(ctx, {
        ...order([{ itemId: cola }]),
        customerId: theirs.id,
        payments: card("11.5"),
      }),
      "NOT_FOUND",
    );
  });
});

describe("customers, points and gift cards on checks", () => {
  it("pays a check with the customer's points, a gift card and a card", async () => {
    await createFloor(ctx, { branchId, warehouseId: kitchenId, name: "Main" });
    const sara = await createCustomer(ctx, { name: "Check guest", phone: "0507777777" });
    await adjustPoints(ctx, sara.id, { points: "100", reason: "Welcome" });
    const card = await sellGiftCard(ctx, { registerId: register, amount: "20", method: "CASH" });
    const tab = await openTab(ctx, { branchId, label: "Table 5", guests: "2" });
    await addTabLines(ctx, tab.id, { lines: [{ itemId: fries, quantity: "2" }] });
    // 46 − 100 points × 0.05 = 41; gift card 20, card 21; 41 points earned.
    const paid = await payTab(ctx, tab.id, {
      orderId: randomUUID(),
      registerId: register,
      customerId: sara.id,
      loyaltyPoints: 100,
      payments: [
        { method: "GIFT_CARD", amount: "20", giftCardCode: card.code },
        { method: "CARD", amount: "21" },
      ],
      expectedTotal: "41",
    });
    const o = await getOrder(ctx, paid.id);
    expect([o.customer?.id, o.loyaltyPoints, o.orderDiscount.toFixed(2)]).toEqual([
      sara.id,
      100,
      "5.00",
    ]);
    expect(await balanceOf(sara.id)).toBe(41);
    expect((await giftCardBalance(ctx, card.code)).balance).toBe("0");
  });
});
