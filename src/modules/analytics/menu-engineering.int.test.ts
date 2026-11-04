import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import {
  createRegister,
  getOrder,
  openShift,
  refundOrder,
  submitOrder,
} from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { exportMenuEngineeringCsv, menuEngineering } from "./menu-engineering";

/** Menu engineering (ADR-107). */

const TZ = "Asia/Riyadh";
let ctx: TenantContext;
let register: string;
let shiftId: string;
let today: string;
let drinks: string;
const items: Record<string, string> = {};

async function sell(code: string, qty: number, total: string) {
  const orderId = randomUUID();
  await submitOrder(ctx, {
    orderId,
    registerId: register,
    shiftId,
    channel: "TAKEAWAY",
    lines: [{ itemId: items[code], quantity: String(qty) }],
    payments: [{ method: "CARD", amount: total }],
  });
  return orderId;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("menu-eng", { baseCurrency: "EGP", timeZone: TZ }));
  today = businessDate(TZ);
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  const branchId = (await createBranch(ctx, { code: "B1", name: "Branch", type: "RESTAURANT" })).id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "K1", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const mains = (await createMenuCategory(ctx, { name: "Mains" })).id;
  drinks = (await createMenuCategory(ctx, { name: "Drinks" })).id;
  for (const [code, price, cost, category] of [
    ["BURGER", "50", "20", mains],
    ["COLA", "10", "3", drinks],
    ["SODA", "8", null, drinks],
  ] as const) {
    const productId = (
      await createProduct(ctx, { sku: code, nameEn: code, type: "FINISHED_GOOD", baseUomId: each })
    ).id;
    if (cost)
      await postOpeningBalance(ctx, {
        warehouseId,
        productId,
        quantity: "100",
        uomId: each,
        unitCost: cost,
      });
    items[code] = (
      await createMenuItem(ctx, { code, name: code, categoryId: category, kind: "ITEM", productId })
    ).id;
    await addMenuItemPrice(ctx, items[code], { channel: "TAKEAWAY", price, effectiveFrom: today });
  }
  register = (await createRegister(ctx, { branchId, warehouseId, code: "T1", name: "Till" })).id;
  shiftId = (await openShift(ctx, register, { openingFloat: "0" })).id;
  await sell("BURGER", 2, "100");
  const colas = await sell("COLA", 10, "100");
  const order = await getOrder(ctx, colas);
  await refundOrder(ctx, colas, {
    registerId: register,
    method: "CARD",
    reason: "Flat",
    lines: [{ orderLineId: order.lines[0].id, quantity: "1" }],
  });
  // Sold with no stock recorded: no known cost.
  await sell("SODA", 1, "8");
}, 60_000);

describe("menu engineering (ADR-107)", () => {
  it("weighs popularity against margin per item", async () => {
    const r = await menuEngineering(ctx, { from: today, to: today });
    const by = (code: string) => r.items.find((i) => i.item.code === code)!;
    // Burger: 2 sold for 100, cost 20 each → margin 30. Cola: 9 kept for 90, cost 3 → margin 7.
    expect([
      by("BURGER").sold.toFixed(),
      by("BURGER").revenue.toFixed(2),
      by("BURGER").unitMargin?.toFixed(2),
    ]).toEqual(["2", "100.00", "30.00"]);
    expect([
      by("COLA").sold.toFixed(),
      by("COLA").revenue.toFixed(2),
      by("COLA").unitCost?.toFixed(2),
    ]).toEqual(["9", "90.00", "3.00"]);
    // Two items analysed: popular from 35 %; average margin (60 + 63) / 11 = 11.18.
    expect(r.popularityThreshold?.toFixed(2)).toBe("0.35");
    expect(r.averageMargin?.toFixed(2)).toBe("11.18");
    expect([by("BURGER").menuClass, by("COLA").menuClass]).toEqual(["PUZZLE", "PLOWHORSE"]);
    expect([by("SODA").menuClass, by("SODA").costGap, by("SODA").revenue.toFixed(2)]).toEqual([
      null,
      "NO_PRODUCT_COST",
      "8.00",
    ]);
    expect(r.counts).toEqual({ STAR: 0, PLOWHORSE: 1, PUZZLE: 1, DOG: 0 });
  });

  it("can look at one category, exports CSV, and needs sales and cost rights", async () => {
    const r = await menuEngineering(ctx, { from: today, to: today }, { categoryId: drinks });
    expect(r.items.map((i) => i.item.code).sort()).toEqual(["COLA", "SODA"]);
    // Only cola has a cost in this category: it is the whole analysis.
    expect(r.items.find((i) => i.item.code === "COLA")!.menuClass).toBe("STAR");
    const csv = await exportMenuEngineeringCsv(ctx, { from: today, to: today });
    expect(csv).toContain("BURGER,BURGER,Mains,2,100.00,50.00,20.00,30.00,60.00,40.0");
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(menuEngineering(cashier.ctx, { from: today, to: today }), "FORBIDDEN");
    const { ctx: other } = await createTenant("menu-eng-other", {
      baseCurrency: "EGP",
      timeZone: TZ,
    });
    expect((await menuEngineering(other, { from: today, to: today })).items).toEqual([]);
  });
});
