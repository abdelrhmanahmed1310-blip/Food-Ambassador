import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../../test/support/factories";
import { linkReferenceFood } from "../library";
import { recordNutritionProfile, verifyNutritionProfile } from "../service";
import { createFood, updateFood } from "./foods";
import { listIssues, nutritionDashboard, resolveIssue, scanQuality } from "./quality";
import { recipeFullNutrition } from "./recipes";

/**
 * Recipes through linked library foods, and data quality (ADR-132).
 * Values are made up for the test only.
 */

let ctx: TenantContext;
let qa: TenantContext;
let analyst: TenantContext;
let rice: string;
let oil: string;
let water: string;
let dishId: string;
let waterFood: string;

type Row = { code: string; amount: string | null; knownAmount: string; complete: boolean };
const byCode = (rows: Row[] | null | undefined) =>
  Object.fromEntries((rows ?? []).map((r) => [r.code, r]));

beforeAll(async () => {
  ({ ctx } = await createTenant("nutrition-recipes"));
  qa = (await addMember(ctx, "food_safety")).ctx;
  analyst = (await addMember(ctx, "analyst", {}, "recipes-analyst")).ctx;
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const product = async (sku: string, baseUomId: string) =>
    (await createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId })).id;
  rice = await product("RICE", units.kg);
  oil = await product("OIL", units.kg);
  water = await product("WATER", units.l);
  const dish = await createRecipe(ctx, {
    code: "PILAF",
    name: "Pilaf",
    type: "DISH",
    yieldQuantity: "1",
    yieldUomId: units.kg,
    portions: "4",
  });
  for (const [item, quantity, uomId] of [
    [rice, "0.3", units.kg],
    [oil, "0.05", units.kg],
    [water, "0.5", units.l],
  ] as const)
    await addIngredient(ctx, dish!.versionId, { item: `product:${item}`, quantity, uomId });
  await activateVersion(ctx, dish!.versionId);
  dishId = dish!.id;

  // Rice: a library food only. Oil: a verified manufacturer specification and a library food.
  const riceFood = await createFood(ctx, {
    name: "Test rice, raw",
    values: { energy_kcal: "360", protein: "7", fat: "0.6", iron: "0.8" },
  });
  await linkReferenceFood(ctx, riceFood.id, { productId: rice, arabicName: "on", nutrition: "on" });
  await recordNutritionProfile(ctx, oil, {
    basis: "PER_100G",
    source: "SUPPLIER_SPEC",
    reference: "Oil spec 1",
    energyKcal: "884",
    fat: "100",
    saturatedFat: "14",
    carbohydrate: "0",
    sugars: "0",
    protein: "0",
    salt: "0",
  });
  await verifyNutritionProfile(qa, oil);
  const oilFood = await createFood(ctx, {
    name: "Test oil, generic",
    values: { energy_kcal: "900", fat: "100", vitamin_e: "14", iron: "0" },
  });
  // Linking the library food must not replace the specification…
  await expectAppError(
    linkReferenceFood(ctx, oilFood.id, { productId: oil, nutrition: "on" }),
    "BUSINESS_RULE_VIOLATION",
  );
  // …but it can be linked for the nutrients the specification does not give.
  await getDb().referenceFood.update({ where: { id: oilFood.id }, data: { linkedProductId: oil } });
  waterFood = (
    await createFood(ctx, {
      name: "Test water",
      basis: "PER_100ML",
      values: { energy_kcal: "0", protein: "0", fat: "0", iron: "0" },
    })
  ).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("recipe full nutrient panel (ADR-132)", () => {
  it("never counts an ingredient without data as zero", async () => {
    const r = await recipeFullNutrition(ctx, dishId);
    const p = r.panel!;
    const cover = Object.fromEntries(p.ingredients.map((i) => [i.productId, i.coverage]));
    expect(cover).toEqual({ [rice]: "LIBRARY", [oil]: "PROFILE_AND_LIBRARY", [water]: "NO_DATA" });
    const total = byCode(p.total);
    // Water has no data: nothing is claimed, but what is known is shown.
    expect(total.energy_kcal.amount).toBeNull();
    // 300 g × 360/100 + 50 g × 884/100 (the specification, not the generic 900)
    expect(total.energy_kcal.knownAmount).toBe("1522");
    expect(total.energy_kcal.complete).toBe(false);
  });

  it("totals per portion and per 100 g once every ingredient is covered", async () => {
    await linkReferenceFood(ctx, waterFood, { productId: water, nutrition: "on" });
    const p = (await recipeFullNutrition(ctx, dishId)).panel!;
    const total = byCode(p.total);
    expect(total.energy_kcal).toMatchObject({ amount: "1522", complete: true });
    // Protein: rice 21 g; the oil specification says 0; water 0.
    expect(total.protein.amount).toBe("21");
    // Vitamin E comes only from the oil's library food (the spec does not give it); rice has none.
    expect(total.vitamin_e.amount).toBeNull();
    expect(total.vitamin_e.knownAmount).toBe("7");
    // Iron: 300 g × 0.8/100 + 0 + 0.
    expect(total.iron.amount).toBe("2.4");
    expect(byCode(p.perPortion).energy_kcal.amount).toBe("380.5");
    expect(byCode(p.per100g).energy_kcal.amount).toBe("152.2");
  });

  it("follows recipe and nutrition permissions", async () => {
    const outsider = (await createTenant("nutrition-recipes-other")).ctx;
    await expectAppError(recipeFullNutrition(outsider, dishId), "NOT_FOUND");
    // Analysts read it.
    expect((await recipeFullNutrition(analyst, dishId)).panel).not.toBeNull();
  });
});

describe("data quality (ADR-132)", () => {
  it("scans for duplicates and lets a person resolve or ignore with a note", async () => {
    await createFood(ctx, { name: "Test rice, raw", values: { energy_kcal: "355" } });
    const scan = await scanQuality(ctx);
    expect(scan.duplicates).toBe(2);
    // A second scan raises nothing new.
    expect((await scanQuality(ctx)).duplicates).toBe(0);
    const open = await listIssues(ctx, { kind: "DUPLICATE_NAME" });
    expect(open.total).toBe(2);
    expect(open.openByKind.DUPLICATE_NAME).toBe(2);
    await expectAppError(
      resolveIssue(ctx, open.items[0].id, { status: "RESOLVED" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      resolveIssue(analyst, open.items[0].id, { status: "RESOLVED", note: "x" }),
      "FORBIDDEN",
    );
    await resolveIssue(ctx, open.items[0].id, { status: "RESOLVED", note: "Merged by hand" });
    await resolveIssue(ctx, open.items[1].id, { status: "IGNORED", note: "Two suppliers" });
    await expectAppError(
      resolveIssue(ctx, open.items[1].id, { status: "RESOLVED", note: "again" }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await listIssues(ctx, { status: "IGNORED" })).items[0].resolutionNote).toBe(
      "Two suppliers",
    );
    // Another organization sees none of it.
    const other = (await createTenant("nutrition-quality-other")).ctx;
    expect((await listIssues(other)).total).toBe(0);
    await expectAppError(
      resolveIssue(other, open.items[0].id, { status: "IGNORED", note: "x" }),
      "NOT_FOUND",
    );
  });

  it("raises missing label nutrients on entry and counts the dashboard from the database", async () => {
    const water = await getDb().referenceFood.findUniqueOrThrow({ where: { id: waterFood } });
    expect(water.verifiedAt).toBeNull();
    await updateFood(ctx, waterFood, { verified: true });
    const d = await nutritionDashboard(ctx);
    // Rice, oil, water and the duplicate rice; the water was just verified.
    expect(d).toMatchObject({ foods: 4, manual: 4, usda: 0, awaitingVerification: 3, archived: 0 });
    expect(d.nutrients).toBeGreaterThanOrEqual(57);
  });
});
