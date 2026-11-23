import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addBarcode,
  createProduct,
  listUnits,
  setProductArchived,
} from "@/modules/catalog/service";
import { addToMenu, createMenuItemPriced, menuCandidates } from "@/modules/menu/bulk";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { matchBarcode } from "./barcode-match";
import { createRegister, openShift, sellableMenu, submitOrder } from "./service";
import { simulatorData } from "./simulator";

/**
 * Every kind of product sells the same way at the till: ingredients, semi-finished
 * products, finished goods (CPG), packaging, consumables and dishes, side by side
 * in one menu category — punched or scanned.
 */

const TYPES = [
  "RAW_MATERIAL",
  "SEMI_FINISHED",
  "FINISHED_GOOD",
  "PACKAGING",
  "CONSUMABLE",
] as const;

let ctx: TenantContext;
let branchId: string;
let kitchen: string;
let register: string;
let each: string;
let dishId: string;
const productOf: Record<string, string> = {};
const itemOf: Record<string, string> = {};

const onHand = async (productId: string) =>
  (
    await getDb().stockBalance.findMany({
      where: { organizationId: ctx.organizationId, warehouseId: kitchen, productId },
    })
  ).reduce((a, r) => a + Number(r.onHandQuantity), 0);

beforeAll(async () => {
  ({ ctx } = await createTenant("pos-product-types"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  each = units.each;
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
  const today = businessDate(ctx.timeZone);
  const everything = (await createMenuCategory(ctx, { name: "Everything" })).id;
  for (const type of TYPES) {
    const id = (
      await createProduct(ctx, {
        sku: `P-${type}`,
        nameEn: `Test ${type}`,
        type,
        baseUomId: units.each,
      })
    ).id;
    productOf[type] = id;
    await addBarcode(ctx, id, { barcode: `BC-${type}`, symbology: "CODE128" });
    await postOpeningBalance(ctx, {
      warehouseId: kitchen,
      productId: id,
      quantity: "10",
      uomId: units.each,
      unitCost: "2",
    });
    itemOf[type] = (await createMenuItem(ctx, {
      code: `I-${type}`,
      name: `Test ${type}`,
      categoryId: everything,
      kind: "ITEM",
      productId: id,
    }))!.id;
  }
  // A dish made from the raw material, in the same category.
  const dish = (await createRecipe(ctx, {
    code: "DISH",
    name: "Test dish",
    type: "DISH",
    yieldQuantity: "1",
    yieldUomId: units.each,
    portions: "1",
  }))!;
  await addIngredient(ctx, dish.versionId, {
    item: `product:${productOf.RAW_MATERIAL}`,
    quantity: "2",
    uomId: units.each,
  });
  await activateVersion(ctx, dish.versionId);
  dishId = dish.id;
  itemOf.DISH = (await createMenuItem(ctx, {
    code: "I-DISH",
    name: "Test dish",
    categoryId: everything,
    kind: "ITEM",
    recipeId: dish.id,
    barcode: "BC-DISH",
  }))!.id;
  for (const id of Object.values(itemOf))
    await addMenuItemPrice(ctx, id, { channel: "TAKEAWAY", price: "10", effectiveFrom: today });
  register = (
    await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL1", name: "Till 1" })
  ).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("every product type at the till", () => {
  it("lists all of them in one category, each found by its barcode, in the till and the simulator", async () => {
    const menu = (await sellableMenu(ctx, branchId, businessDate(ctx.timeZone))).find(
      (c) => c.channel === "TAKEAWAY",
    )!;
    expect(new Set(menu.items.map((i) => i.category.name))).toEqual(new Set(["Everything"]));
    expect(menu.items.map((i) => i.id).sort()).toEqual(Object.values(itemOf).sort());
    for (const [type, itemId] of Object.entries(itemOf))
      expect(matchBarcode(menu.items, `BC-${type}`)?.id, type).toBe(itemId);
    const sim = (await simulatorData(ctx, branchId)).channels.find(
      (c) => c.channel === "TAKEAWAY",
    )!;
    expect(sim.items).toHaveLength(6);
  });

  it("sells one of each in a single paid order and uses each product's stock", async () => {
    await openShift(ctx, register, { openingFloat: "0" });
    const before = Object.fromEntries(
      await Promise.all(TYPES.map(async (t) => [t, await onHand(productOf[t])] as const)),
    );
    const order = await submitOrder(ctx, {
      orderId: randomUUID(),
      registerId: register,
      channel: "TAKEAWAY",
      lines: Object.values(itemOf).map((itemId) => ({ itemId, quantity: "1", optionIds: [] })),
      payments: [{ method: "CASH", amount: "60" }],
    });
    expect([order.number.length > 0, order.duplicate]).toEqual([true, false]);
    for (const t of TYPES)
      // The raw material is sold on its own and is also the dish's ingredient (2 each).
      expect(await onHand(productOf[t]), t).toBe(before[t] - (t === "RAW_MATERIAL" ? 3 : 1));
  });
});

describe("adding products and dishes to the menu in bulk (ADR-138)", () => {
  it("adds any product type and dishes to one category, priced on the chosen channels", async () => {
    const ids: Record<string, string> = {};
    for (const type of TYPES)
      ids[type] = (
        await createProduct(ctx, {
          sku: `BULK.${type}.1KG-PACK`,
          nameEn: `Bulk ${type}`,
          nameAr: "منتج",
          type,
          baseUomId: each,
        })
      ).id;
    const gone = (
      await createProduct(ctx, {
        sku: "BULK-OLD",
        nameEn: "Old",
        type: "FINISHED_GOOD",
        baseUomId: each,
      })
    ).id;
    const candidates = await menuCandidates(ctx, { q: "bulk" });
    expect(candidates.rows.filter((r) => r.source === "PRODUCT")).toHaveLength(6);
    expect(
      (await menuCandidates(ctx, { type: "DISH" })).rows.find((r) => r.id === dishId)?.onMenu,
    ).toBe(true);
    await setProductArchived(ctx, gone, true);

    const category = (await createMenuCategory(ctx, { name: "Bulk" })).id;
    const r = await addToMenu(ctx, {
      categoryId: category,
      channels: ["DINE_IN", "TAKEAWAY"],
      lines: [
        ...TYPES.map((t) => ({ source: "PRODUCT", id: ids[t], price: "7.5" })),
        { source: "DISH", id: dishId, price: "20" }, // already on the menu
        { source: "PRODUCT", id: gone, price: "1" }, // archived
        { source: "PRODUCT", id: productOf.RAW_MATERIAL, price: "abc" }, // already on the menu
      ],
    });
    expect(r.created).toHaveLength(5);
    expect(r.created[0].code).toBe("BULK-RAW_MATERIAL-1K");
    expect(r.skipped.map((s) => s.reason).sort()).toEqual([
      "ALREADY_ON_MENU",
      "ALREADY_ON_MENU",
      "PRODUCT_ARCHIVED",
    ]);
    const dineIn = (await sellableMenu(ctx, branchId, businessDate(ctx.timeZone))).find(
      (c) => c.channel === "DINE_IN",
    )!;
    const bulk = dineIn.items.filter((i) => i.category.name === "Bulk");
    expect(bulk.map((i) => i.price.toString())).toEqual(Array(5).fill("7.5"));
    expect(bulk.every((i) => i.nameAr === "منتج")).toBe(true);
    // A bad price is reported, and nothing is created for that line.
    const bad = await createProduct(ctx, {
      sku: "BULK-BAD",
      nameEn: "Bad",
      type: "RAW_MATERIAL",
      baseUomId: each,
    });
    const r2 = await addToMenu(ctx, {
      categoryId: category,
      channels: ["DINE_IN"],
      lines: [{ source: "PRODUCT", id: bad.id, price: "1,5" }],
    });
    expect([r2.created.length, r2.skipped[0].reason]).toEqual([0, "PRICE_INVALID"]);
  });

  it("needs menu.manage and stays in the organization", async () => {
    const analyst = (await addMember(ctx, "analyst", {}, "bulk-menu-analyst")).ctx;
    await expectAppError(menuCandidates(analyst), "FORBIDDEN");
    const other = (await createTenant("pos-product-types-other")).ctx;
    const cat = (await createMenuCategory(other, { name: "X" })).id;
    const r = await addToMenu(other, {
      categoryId: cat,
      lines: [{ source: "PRODUCT", id: productOf.CONSUMABLE }],
    });
    expect(r).toEqual({
      created: [],
      skipped: [{ id: productOf.CONSUMABLE, name: "", reason: "NOT_FOUND" }],
    });
    await expectAppError(
      addToMenu(ctx, { categoryId: cat, lines: [{ source: "PRODUCT", id: productOf.CONSUMABLE }] }),
      "NOT_FOUND",
    );
  });
});

describe("fewer steps (ADR-139)", () => {
  it("creates a product with its first barcode in one step, or nothing", async () => {
    const p = await createProduct(ctx, {
      sku: "ONE-STEP",
      nameEn: "One step",
      type: "FINISHED_GOOD",
      baseUomId: each,
      barcode: "6281000000014",
      barcodeSymbology: "EAN13",
    });
    const codes = await getDb().productBarcode.findMany({ where: { productId: p.id } });
    expect(codes.map((c) => c.barcode)).toEqual(["6281000000014"]);
    const count = () =>
      getDb().product.count({
        where: { organizationId: ctx.organizationId, sku: { startsWith: "TWO-" } },
      });
    // A wrong check digit, or a barcode already in use: no product is created.
    await expectAppError(
      createProduct(ctx, {
        sku: "TWO-A",
        nameEn: "A",
        type: "RAW_MATERIAL",
        baseUomId: each,
        barcode: "6281000000015",
        barcodeSymbology: "EAN13",
      }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createProduct(ctx, {
        sku: "TWO-B",
        nameEn: "B",
        type: "RAW_MATERIAL",
        baseUomId: each,
        barcode: "6281000000014",
        barcodeSymbology: "EAN13",
      }),
      "CONFLICT",
    );
    expect(await count()).toBe(0);
  });

  it("creates a menu item priced on the chosen channels, or nothing when the price is wrong", async () => {
    const category = (await createMenuCategory(ctx, { name: "One step" })).id;
    const item = await createMenuItemPriced(ctx, {
      code: "PRICED",
      name: "Priced",
      categoryId: category,
      kind: "ITEM",
      productId: productOf.FINISHED_GOOD,
      price: "12.5",
      sellOn: ["DINE_IN", "DELIVERY"],
    });
    const prices = await getDb().menuItemPrice.findMany({ where: { itemId: item.id } });
    expect(prices.map((p) => [p.channel, p.price.toString()]).sort()).toEqual([
      ["DELIVERY", "12.5"],
      ["DINE_IN", "12.5"],
    ]);
    await expectAppError(
      createMenuItemPriced(ctx, {
        code: "BADPRICE",
        name: "Bad",
        categoryId: category,
        kind: "ITEM",
        productId: productOf.FINISHED_GOOD,
        price: "12,5",
        sellOn: ["DINE_IN"],
      }),
      "VALIDATION_FAILED",
    );
    expect(
      await getDb().menuItem.count({
        where: { organizationId: ctx.organizationId, code: "BADPRICE" },
      }),
    ).toBe(0);
    // Without a price it is added unpriced, as before.
    const plain = await createMenuItemPriced(ctx, {
      code: "PLAIN",
      name: "Plain",
      categoryId: category,
      kind: "ITEM",
      productId: productOf.CONSUMABLE,
      sellOn: ["DINE_IN"],
    });
    expect(await getDb().menuItemPrice.count({ where: { itemId: plain.id } })).toBe(0);
  });
});
