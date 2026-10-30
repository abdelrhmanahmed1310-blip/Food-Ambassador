import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, createUnit, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance, revalueStock } from "@/modules/inventory/operations";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { postReceipt } from "@/modules/procurement/receipts";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import type { VersionCost } from "./costing";
import {
  addStandardCost,
  calculateVersionCost,
  getSnapshot,
  listSnapshots,
  listStandardCosts,
  saveSnapshot,
} from "./costs";
import {
  activateVersion,
  addIngredient,
  createDraftVersion,
  createRecipe,
  discardDraft,
  getRecipe,
  getVersion,
  listRecipes,
  removeIngredient,
  setRecipeArchived,
  updateVersion,
} from "./recipes";

let ctx: TenantContext;
let units: Record<string, string>;
let warehouseId: string;
let otherWarehouse: string;
let tomato: string; // kg, average 20
let oil: string; // l, standard 80
let egg: string; // each, bought at 3.5
let saffron: string; // g, no cost
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

const product = (id: string) => `product:${id}`;
const recipe = (id: string) => `recipe:${id}`;

async function activeRecipe(
  input: {
    code: string;
    type: "DISH" | "PREPARATION";
    yieldQuantity: string;
    yieldUom: string;
    portions?: string;
  },
  lines: Array<{ item: string; quantity: string; uom: string; wastePercent?: string }>,
) {
  const created = await createRecipe(ctx, {
    code: input.code,
    name: input.code,
    type: input.type,
    yieldQuantity: input.yieldQuantity,
    yieldUomId: units[input.yieldUom],
    portions: input.portions,
  });
  for (const l of lines)
    await addIngredient(ctx, created!.versionId, {
      item: l.item,
      quantity: l.quantity,
      uomId: units[l.uom],
      wastePercent: l.wastePercent,
    });
  await activateVersion(ctx, created!.versionId);
  return created!;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("recipes"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  units.tray = (
    await createUnit(ctx, { code: "tray", nameEn: "Tray", nameAr: "صينية", dimension: "COUNT" })
  ).id;
  const branchId = (await createBranch(ctx, { code: "HQ", name: "HQ", type: "RESTAURANT" })).id;
  warehouseId = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" }))
    .id;
  otherWarehouse = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const make = async (sku: string, baseUomId: string) =>
    (await createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId })).id;
  tomato = await make("TOMATO", units.kg);
  oil = await make("OIL", units.l);
  egg = await make("EGG", units.each);
  saffron = await make("SAFFRON", units.g);
  await postOpeningBalance(ctx, {
    warehouseId,
    productId: tomato,
    quantity: "10",
    uomId: units.kg,
    unitCost: "20",
  });
  await postOpeningBalance(ctx, {
    warehouseId: otherWarehouse,
    productId: tomato,
    quantity: "10",
    uomId: units.kg,
    unitCost: "30",
  });
  await addStandardCost(ctx, oil, { unitCost: "80", effectiveFrom: yesterday });
  await addStandardCost(ctx, oil, { unitCost: "95", effectiveFrom: nextMonth });
  // Eggs: bought at 105 per case of 30 → 3.5 each.
  const supplierId = (await createSupplier(ctx, { code: "FARM", name: "Farm" })).id;
  const { id: orderId } = await createOrder(ctx, { supplierId, warehouseId });
  await addOrderLine(ctx, orderId, {
    productId: egg,
    quantity: "60",
    uomId: units.each,
    unitPrice: "3.5",
  });
  await submitOrder(ctx, orderId);
  const order = await getOrder(ctx, orderId);
  await postReceipt(ctx, orderId, {
    lines: [{ purchaseOrderLineId: order.lines[0].id, receivedQuantity: "60", unitPrice: "3.5" }],
  });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("recipes", () => {
  it("costs a preparation with waste, takes a snapshot on activation and locks the version", async () => {
    const sauce = await activeRecipe(
      { code: "SAUCE", type: "PREPARATION", yieldQuantity: "2", yieldUom: "kg" },
      [
        { item: product(tomato), quantity: "2.4", uom: "kg", wastePercent: "20" },
        { item: product(oil), quantity: "100", uom: "ml" },
      ],
    );
    const version = await getVersion(ctx, sauce.versionId);
    expect(version.status).toBe("ACTIVE");
    const [snapshot] = await listSnapshots(ctx, sauce.id);
    // Tomato: 3 kg gross × 25 (organization average of 20 and 30) = 75; oil: 0.1 l × 80 standard = 8.
    expect(snapshot).toMatchObject({ reason: "ACTIVATION", policy: "AVERAGE", missingCount: 0 });
    expect(snapshot.totalCost.toFixed()).toBe("83");
    expect(snapshot.costPerYieldUnit.toFixed()).toBe("41.5");
    const stored = await getSnapshot(ctx, snapshot.id);
    expect(stored.breakdown.lines.map((l) => [l.source, l.cost])).toEqual([
      ["AVERAGE", "75"],
      ["STANDARD", "8"],
    ]);
    // One warehouse's average instead of the organization's.
    const main = await calculateVersionCost(ctx, sauce.versionId, {
      policy: "AVERAGE",
      warehouseId,
    });
    expect(main.cost.totalCost).toBe("68");

    // Active versions cannot change, through the service or directly in the database.
    await expectAppError(
      addIngredient(ctx, sauce.versionId, { item: product(egg), quantity: "1", uomId: units.each }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expect(
      getDb().recipeVersion.update({
        where: { id: sauce.versionId },
        data: { yieldQuantity: "3" },
      }),
    ).rejects.toThrow();
    await expect(
      getDb().recipeIngredient.updateMany({
        where: { versionId: sauce.versionId },
        data: { quantity: "1" },
      }),
    ).rejects.toThrow();
  });

  it("costs a dish per portion through a sub-recipe, with the chosen source first", async () => {
    const sauceId = (await listRecipes(ctx, { q: "SAUCE" })).items[0].id;
    const pasta = await activeRecipe(
      { code: "PASTA", type: "DISH", yieldQuantity: "4", yieldUom: "each", portions: "4" },
      [
        { item: recipe(sauceId), quantity: "500", uom: "g" },
        { item: product(egg), quantity: "2", uom: "each" },
        { item: product(saffron), quantity: "1", uom: "g" },
      ],
    );
    const live = await calculateVersionCost(ctx, pasta.versionId, { policy: "LAST_PURCHASE" });
    const lines = live.cost.lines;
    // Sauce: 0.5 kg × 41.5 = 20.75; eggs: 2 × 3.5 = 7 (last purchase); saffron has no cost.
    expect(lines[0]).toMatchObject({ source: "SUB_RECIPE", unitCost: "41.5", cost: "20.75" });
    expect(lines[1]).toMatchObject({
      source: "LAST_PURCHASE",
      cost: "7",
      sourceRef: expect.stringMatching(/^GRN-/),
    });
    expect(lines[2]).toMatchObject({ missing: "NO_COST", cost: null });
    expect(live.cost).toMatchObject({
      totalCost: "27.75",
      costPerPortion: "6.9375",
      missingCount: 1,
    });
    expect(live.names[saffron].code).toBe("SAFFRON");
    // Average first: eggs at the stock average (3.5 as well, from the receipt).
    const average = await calculateVersionCost(ctx, pasta.versionId, { policy: "AVERAGE" });
    expect(average.cost.lines[1].source).toBe("AVERAGE");
  });

  it("recalculates on cost changes while stored snapshots stay as they were", async () => {
    const sauce = (await listRecipes(ctx, { q: "SAUCE" })).items[0];
    const [before] = await listSnapshots(ctx, sauce.id);
    await revalueStock(ctx, {
      warehouseId,
      productId: tomato,
      unitCost: "40",
      reasonCode: "COST_CORRECTION",
    });
    const versionId = sauce.versions[0].id;
    // Organization average is now (400 + 300) / 20 = 35 → 105 + 8.
    expect((await calculateVersionCost(ctx, versionId, {})).cost.totalCost).toBe("113");
    const manual = await saveSnapshot(ctx, versionId, { policy: "AVERAGE" });
    expect(manual.totalCost.toFixed()).toBe("113");
    const history = await listSnapshots(ctx, sauce.id);
    expect(history.map((s) => s.totalCost.toFixed())).toEqual(["113", "83"]);
    const old = await getSnapshot(ctx, before.id);
    expect(old.totalCost.toFixed()).toBe("83");
    expect((old.breakdown as VersionCost).lines[0].unitCost).toBe("25");
  });

  it("versions: one draft at a time, copies ingredients, retires the old version", async () => {
    const sauce = (await listRecipes(ctx, { q: "SAUCE" })).items[0];
    const draft = await createDraftVersion(ctx, sauce.id);
    expect(draft.versionNo).toBe(2);
    await expectAppError(createDraftVersion(ctx, sauce.id), "BUSINESS_RULE_VIOLATION");
    let v2 = await getVersion(ctx, draft.id);
    expect(v2.ingredients).toHaveLength(2);
    await removeIngredient(ctx, draft.id, v2.ingredients[1].id);
    await updateVersion(ctx, draft.id, { yieldQuantity: "2.5", yieldUomId: units.kg });
    await expectAppError(
      updateVersion(ctx, draft.id, { yieldQuantity: "1", yieldUomId: units.tray }),
      "BUSINESS_RULE_VIOLATION",
    );
    await activateVersion(ctx, draft.id);
    v2 = await getVersion(ctx, draft.id);
    expect(v2.status).toBe("ACTIVE");
    const versions = (await getRecipe(ctx, sauce.id)).versions;
    expect(versions.map((v) => [v.versionNo, v.status])).toEqual([
      [2, "ACTIVE"],
      [1, "RETIRED"],
    ]);
    const v3 = await createDraftVersion(ctx, sauce.id);
    await discardDraft(ctx, v3.id);
    expect((await getRecipe(ctx, sauce.id)).versions).toHaveLength(2);
    const lonely = await createRecipe(ctx, {
      code: "LONELY",
      name: "Lonely",
      type: "PREPARATION",
      yieldQuantity: "1",
      yieldUomId: units.kg,
    });
    await expectAppError(discardDraft(ctx, lonely!.versionId), "BUSINESS_RULE_VIOLATION");
    await expectAppError(activateVersion(ctx, lonely!.versionId), "BUSINESS_RULE_VIOLATION");
  });

  it("refuses cycles, dishes as sub-recipes, missing portions and archiving recipes in use", async () => {
    const sauce = (await listRecipes(ctx, { q: "SAUCE" })).items[0];
    const pasta = (await listRecipes(ctx, { q: "PASTA" })).items[0];
    const base = await activeRecipe(
      { code: "BASE", type: "PREPARATION", yieldQuantity: "1", yieldUom: "kg" },
      [{ item: recipe(sauce.id), quantity: "1", uom: "kg" }],
    );
    const draft = await createDraftVersion(ctx, sauce.id);
    await expectAppError(
      addIngredient(ctx, draft.id, { item: recipe(base.id), quantity: "1", uomId: units.kg }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      addIngredient(ctx, draft.id, { item: recipe(pasta.id), quantity: "1", uomId: units.each }),
      "BUSINESS_RULE_VIOLATION",
    );
    // A sub-recipe quantity must convert to its yield unit.
    const other = await createRecipe(ctx, {
      code: "TOPPING",
      name: "Topping",
      type: "PREPARATION",
      yieldQuantity: "1",
      yieldUomId: units.kg,
    });
    await expectAppError(
      addIngredient(ctx, other!.versionId, {
        item: recipe(base.id),
        quantity: "1",
        uomId: units.l,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      createRecipe(ctx, {
        code: "SOUP",
        name: "Soup",
        type: "DISH",
        yieldQuantity: "5",
        yieldUomId: units.l,
      }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createRecipe(ctx, {
        code: "sauce",
        name: "Again",
        type: "PREPARATION",
        yieldQuantity: "1",
        yieldUomId: units.kg,
      }),
      "CONFLICT",
    );
    await expectAppError(
      addIngredient(ctx, other!.versionId, {
        item: product(tomato),
        quantity: "1",
        uomId: units.l,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      addIngredient(ctx, other!.versionId, {
        item: product(tomato),
        quantity: "1",
        uomId: units.kg,
        wastePercent: "100",
      }),
      "VALIDATION_FAILED",
    );
    await expectAppError(setRecipeArchived(ctx, sauce.id, true), "BUSINESS_RULE_VIOLATION");
    await setRecipeArchived(ctx, pasta.id, true);
    expect((await listRecipes(ctx, { archived: true })).items.map((r) => r.code)).toContain(
      "PASTA",
    );
  });

  it("keeps standard cost history and ignores future-dated costs", async () => {
    const history = await listStandardCosts(ctx, oil);
    expect(history.map((h) => h.unitCost.toFixed())).toEqual(["95", "80"]);
    await expectAppError(
      addStandardCost(ctx, oil, { unitCost: "81", effectiveFrom: yesterday }),
      "CONFLICT",
    );
    await expectAppError(
      addStandardCost(ctx, oil, { unitCost: "-1", effectiveFrom: "2026-01-01" }),
      "VALIDATION_FAILED",
    );
  });

  it("hides costs from users without cost permission and recipes from other tenants", async () => {
    const sauce = (await listRecipes(ctx, { q: "SAUCE" })).items[0];
    const kitchen = (await addMember(ctx, "warehouse")).ctx;
    expect((await getRecipe(kitchen, sauce.id)).can.edit).toBe(false);
    await expectAppError(calculateVersionCost(kitchen, sauce.versions[0].id, {}), "FORBIDDEN");
    await expectAppError(listSnapshots(kitchen, sauce.id), "FORBIDDEN");
    await expectAppError(
      createRecipe(kitchen, {
        code: "X",
        name: "X",
        type: "PREPARATION",
        yieldQuantity: "1",
        yieldUomId: units.kg,
      }),
      "FORBIDDEN",
    );
    const finance = (await addMember(ctx, "finance")).ctx;
    expect((await calculateVersionCost(finance, sauce.versions[0].id, {})).cost.missingCount).toBe(
      0,
    );

    const other = await createTenant("recipes-other");
    await expectAppError(getRecipe(other.ctx, sauce.id), "NOT_FOUND");
    await expectAppError(getVersion(other.ctx, sauce.versions[0].id), "NOT_FOUND");
    await expectAppError(calculateVersionCost(other.ctx, sauce.versions[0].id, {}), "NOT_FOUND");
    await expectAppError(
      calculateVersionCost(ctx, sauce.versions[0].id, {
        warehouseId: (await createTenant("x")).ctx.organizationId,
      }),
      "NOT_FOUND",
    );
  });
});
