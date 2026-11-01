import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { saleMoment } from "./discounts";
import {
  archiveCoupon,
  archivePromotion,
  createCoupon,
  createPromotion,
  listPromotions,
} from "./promotions";
import {
  couponForRegister,
  createRegister,
  getOrder,
  getShift,
  openShift,
  refundOrder,
  submitOrder,
  tillData,
} from "./service";
import { addTabLines, createFloor, getTab, openTab, payTab } from "./tables";

/** Discounts, promotions and coupons (ADR-067). Prices include 15 % VAT. */

let ctx: TenantContext;
let other: TenantContext;
let branchId: string;
let kitchen: string;
let register: string;
let shiftId: string;
let fries: string;
let cola: string;
let sides: string;
let today: string;

const TZ = "Asia/Riyadh";
const card = (amount: string) => [{ method: "CARD" as const, amount }];
const order = (lines: Array<{ itemId: string; quantity?: string }>, extra = {}) => ({
  orderId: randomUUID(),
  registerId: register,
  channel: "DINE_IN" as const,
  lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity ?? "1" })),
  ...extra,
});
const dayName = (offset: number) =>
  saleMoment("DINE_IN", TZ, new Date(Date.now() + offset)).weekday;

beforeAll(async () => {
  ({ ctx } = await createTenant("discounts", { baseCurrency: "SAR", timeZone: TZ }));
  ({ ctx: other } = await createTenant("discounts-other", { baseCurrency: "SAR", timeZone: TZ }));
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
  kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const product = async (sku: string) => {
    const id = (
      await createProduct(ctx, { sku, nameEn: sku, type: "FINISHED_GOOD", baseUomId: units.each })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId: kitchen,
      productId: id,
      quantity: "50",
      uomId: units.each,
      unitCost: "2",
    });
    return id;
  };
  today = businessDate(TZ);
  sides = (await createMenuCategory(ctx, { name: "Sides" })).id;
  const drinks = (await createMenuCategory(ctx, { name: "Drinks" })).id;
  fries = (
    await createMenuItem(ctx, {
      code: "FRIES",
      name: "Fries",
      categoryId: sides,
      kind: "ITEM",
      productId: await product("FRIES"),
    })
  ).id;
  cola = (
    await createMenuItem(ctx, {
      code: "COLA",
      name: "Cola",
      categoryId: drinks,
      kind: "ITEM",
      productId: await product("COLA"),
    })
  ).id;
  await addMenuItemPrice(ctx, fries, { channel: "DINE_IN", price: "23", effectiveFrom: today });
  await addMenuItemPrice(ctx, cola, { channel: "DINE_IN", price: "11.5", effectiveFrom: today });
  register = (
    await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL1", name: "Till" })
  ).id;
  shiftId = (await openShift(ctx, register, { openingFloat: "0" })).id;
  await createPromotion(ctx, {
    name: "Sides 20",
    percent: "20",
    categoryIds: [sides],
    validFrom: today,
  });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("promotions (ADR-067)", () => {
  it("takes the promotion off the item and VAT from what is left", async () => {
    const o = await submitOrder(ctx, {
      ...order([{ itemId: fries }, { itemId: cola }]),
      payments: card("29.9"),
      expectedTotal: "29.9",
    });
    const full = await getOrder(ctx, o.id);
    expect(full.promoDiscount.toFixed(2)).toBe("4.60");
    expect(full.orderDiscount.toFixed(2)).toBe("0.00");
    expect(full.grossAmount.toFixed(2)).toBe("29.90");
    const f = full.lines.find((l) => l.menuItemId === fries)!;
    expect(
      [f.discountAmount, f.grossAmount, f.netAmount, f.taxAmount].map((v) => v.toFixed(2)),
    ).toEqual(["4.60", "18.40", "16.00", "2.40"]);
    expect(f.promotionId).not.toBeNull();
    const c = full.lines.find((l) => l.menuItemId === cola)!;
    expect(c.discountAmount.toFixed(2)).toBe("0.00");
  });

  it("refuses the undiscounted total the till did not show", async () => {
    await expectAppError(
      submitOrder(ctx, {
        ...order([{ itemId: fries }]),
        payments: card("23"),
        expectedTotal: "23",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("does not apply on other days or hours, and the best promotion wins", async () => {
    const yesterday = dayName(-86_400_000);
    const hour = Number(saleMoment("DINE_IN", TZ, new Date()).time.slice(0, 2));
    const at = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
    const notToday = await createPromotion(ctx, {
      name: "Not today",
      percent: "90",
      itemIds: [fries],
      weekdays: [String(yesterday)],
      validFrom: today,
    });
    const later = await createPromotion(ctx, {
      name: "Later hours",
      percent: "80",
      itemIds: [fries],
      startTime: at(hour + 2),
      endTime: at(hour + 4),
      validFrom: today,
    });
    const best = await createPromotion(ctx, {
      name: "Fries 30",
      percent: "30",
      itemIds: [fries],
      validFrom: today,
    });
    // 30 % beats the category's 20 %; the other two do not apply now.
    const o = await submitOrder(ctx, {
      ...order([{ itemId: fries }]),
      payments: card("16.1"),
      expectedTotal: "16.1",
    });
    const full = await getOrder(ctx, o.id);
    expect(full.promoDiscount.toFixed(2)).toBe("6.90");
    expect(full.lines[0].promotionId).toBe(best.id);
    for (const p of [notToday, later, best]) await archivePromotion(ctx, p.id);
  });

  it("prices an order queued offline with the promotions the till had then", async () => {
    const { openedAt } = await getShift(ctx, shiftId);
    const queued = (asOf: Date) => ({
      ...order([{ itemId: cola }]),
      menuAsOf: asOf.toISOString(),
      orderedAt: new Date().toISOString(),
      shiftId,
    });
    const p = await createPromotion(ctx, {
      name: "Cola 10",
      percent: "10",
      itemIds: [cola],
      validFrom: today,
    });
    const between = new Date();
    await archivePromotion(ctx, p.id);
    // A till that loaded its menu before the promotion existed does not apply it…
    const before = await submitOrder(ctx, {
      ...queued(openedAt),
      payments: card("11.5"),
      expectedTotal: "11.5",
    });
    expect((await getOrder(ctx, before.id)).promoDiscount.toFixed(2)).toBe("0.00");
    // …one that loaded it while it was live applies it, though it was archived since.
    const during = await submitOrder(ctx, {
      ...queued(between),
      payments: card("10.35"),
      expectedTotal: "10.35",
    });
    expect((await getOrder(ctx, during.id)).promoDiscount.toFixed(2)).toBe("1.15");
  });

  it("is never edited, only archived", async () => {
    const p = (await listPromotions(ctx)).promotions.find((x) => x.name === "Sides 20")!;
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.posPromotion.update({ where: { id: p.id }, data: { percent: "99" } }),
      ),
    ).rejects.toThrow();
  });

  it("shows on the till and on a check, and applies when the check is paid", async () => {
    const till = await tillData(ctx, register);
    expect(till.promotions.map((p) => p.name)).toContain("Sides 20");
    await createFloor(ctx, { branchId, warehouseId: kitchen, name: "Main" });
    const tab = await openTab(ctx, { branchId, label: "Bar 1", guests: "1" });
    await addTabLines(ctx, tab.id, { lines: [{ itemId: fries, quantity: "2" }] });
    const line = (await getTab(ctx, tab.id)).lines[0];
    expect(line.promotion).toEqual({ name: "Sides 20", percent: "20" });
    const paid = await payTab(ctx, tab.id, {
      orderId: randomUUID(),
      registerId: register,
      payments: card("36.8"),
      expectedTotal: "36.8",
    });
    expect((await getOrder(ctx, paid.id)).promoDiscount.toFixed(2)).toBe("9.20");
  });
});

describe("manual discounts", () => {
  it("needs pos.discount and a reason, and is spread over the lines", async () => {
    const cashier = (await addMember(ctx, "cashier", { scopeType: "BRANCH", branchId })).ctx;
    const discount = { kind: "PERCENT", value: "10", reason: "Regular guest" };
    await expectAppError(
      submitOrder(cashier, {
        ...order([{ itemId: fries }, { itemId: cola }]),
        discount,
        payments: card("26.91"),
      }),
      "FORBIDDEN",
    );
    await expectAppError(
      submitOrder(ctx, {
        ...order([{ itemId: fries }]),
        discount: { kind: "PERCENT", value: "10" },
        payments: card("16.56"),
      }),
      "VALIDATION_FAILED",
    );
    const o = await submitOrder(ctx, {
      ...order([{ itemId: fries }, { itemId: cola }]),
      discount,
      payments: card("26.91"),
      expectedTotal: "26.91",
    });
    const full = await getOrder(ctx, o.id);
    expect(full.orderDiscount.toFixed(2)).toBe("2.99");
    expect(full.discountReason).toBe("Regular guest");
    const gross = full.lines.map((l) => l.grossAmount.toFixed(2));
    expect(gross).toEqual(["16.56", "10.35"]);
    for (const l of full.lines)
      expect(l.netAmount.plus(l.taxAmount).toFixed(2)).toBe(l.grossAmount.toFixed(2));

    // A refund gives back what was paid for the line, not its menu price.
    const refund = await refundOrder(ctx, o.id, {
      registerId: register,
      method: "CARD",
      reason: "Cold",
      lines: [{ orderLineId: full.lines[0].id, quantity: "1" }],
    });
    expect(refund.amount.toFixed(2)).toBe("16.56");
  });

  it("caps an amount at the order, and an order discounted to nothing takes no payment", async () => {
    const o = await submitOrder(ctx, {
      ...order([{ itemId: cola }]),
      discount: { kind: "AMOUNT", value: "50", reason: "Complaint" },
      payments: [],
      expectedTotal: "0",
    });
    const full = await getOrder(ctx, o.id);
    expect(full.grossAmount.toFixed(2)).toBe("0.00");
    expect(full.orderDiscount.toFixed(2)).toBe("11.50");
    expect(full.payments).toHaveLength(0);
    await expectAppError(
      submitOrder(ctx, { ...order([{ itemId: cola }]), payments: [] }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("counts discounts in the shift report", async () => {
    const shift = await getShift(ctx, shiftId);
    expect(shift.totals.discounts.count).toBeGreaterThanOrEqual(2);
    expect(shift.totals.discounts.promotions.gt(0)).toBe(true);
  });
});

describe("coupons", () => {
  it("applies a coupon until it is used up", async () => {
    await createCoupon(ctx, {
      code: "welcome5",
      kind: "AMOUNT",
      value: "5",
      validFrom: today,
      maxUses: "1",
    });
    expect(await couponForRegister(ctx, register, "WELCOME5")).toEqual({
      code: "WELCOME5",
      kind: "AMOUNT",
      value: "5",
    });
    const o = await submitOrder(ctx, {
      ...order([{ itemId: cola }]),
      couponCode: "WELCOME5",
      payments: card("6.5"),
      expectedTotal: "6.5",
    });
    const full = await getOrder(ctx, o.id);
    expect(full.coupon?.code).toBe("WELCOME5");
    expect(full.orderDiscount.toFixed(2)).toBe("5.00");
    await expectAppError(
      submitOrder(ctx, {
        ...order([{ itemId: cola }]),
        couponCode: "WELCOME5",
        payments: card("6.5"),
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(couponForRegister(ctx, register, "WELCOME5"), "BUSINESS_RULE_VIOLATION");
    const c = await getDb().posCoupon.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, code: "WELCOME5" },
    });
    expect(c.uses).toBe(1);
  });

  it("refuses unknown, future, archived and doubled discounts", async () => {
    await expectAppError(couponForRegister(ctx, register, "NOPE"), "BUSINESS_RULE_VIOLATION");
    await createCoupon(ctx, {
      code: "LATER",
      kind: "PERCENT",
      value: "10",
      validFrom: addDays(today, 3),
    });
    await expectAppError(couponForRegister(ctx, register, "LATER"), "BUSINESS_RULE_VIOLATION");
    const gone = await createCoupon(ctx, {
      code: "GONE",
      kind: "PERCENT",
      value: "10",
      validFrom: today,
    });
    await archiveCoupon(ctx, gone.id);
    await expectAppError(couponForRegister(ctx, register, "GONE"), "BUSINESS_RULE_VIOLATION");
    await expectAppError(
      createCoupon(ctx, { code: "BIG", kind: "PERCENT", value: "150", validFrom: today }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createCoupon(ctx, { code: "gone", kind: "PERCENT", value: "10", validFrom: today }),
      "CONFLICT",
    );
    await expectAppError(
      submitOrder(ctx, {
        ...order([{ itemId: cola }]),
        couponCode: "WELCOME5",
        discount: { kind: "PERCENT", value: "10", reason: "x" },
        payments: card("10"),
      }),
      "VALIDATION_FAILED",
    );
  });
});

describe("tenant isolation", () => {
  it("keeps promotions and coupons to their organization", async () => {
    const mine = (await listPromotions(ctx)).promotions[0];
    await expectAppError(archivePromotion(other, mine.id), "NOT_FOUND");
    expect((await listPromotions(other)).promotions).toHaveLength(0);
    // Another organization's item or category cannot be promoted.
    await expectAppError(
      createPromotion(other, {
        name: "Steal",
        percent: "50",
        categoryIds: [sides],
        validFrom: today,
      }),
      "NOT_FOUND",
    );
    // The same code in another organization is a different coupon.
    await createCoupon(other, { code: "WELCOME5", kind: "AMOUNT", value: "5", validFrom: today });
    const theirs = await getDb().posCoupon.findFirstOrThrow({
      where: { organizationId: other.organizationId, code: "WELCOME5" },
    });
    expect(theirs.uses).toBe(0);
    await expectAppError(couponForRegister(other, register, "WELCOME5"), "NOT_FOUND");
    // Row-level security hides the rows from the other tenant's connection.
    const seen = await withTenantTx(other.organizationId, (tx) =>
      tx.posPromotion.findMany({ where: { id: mine.id } }),
    );
    expect(seen).toHaveLength(0);
  });
});
