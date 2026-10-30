import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addConversion, createProduct, listUnits } from "@/modules/catalog/service";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { ALLERGEN_CODES } from "./allergens";
import {
  allergenMatrix,
  declareAllergens,
  generateLabel,
  getLabel,
  getProductNutrition,
  listLabels,
  recipeNutrition,
  recordNutritionProfile,
  reviewLabel,
  verifyAllergenDeclarations,
  verifyNutritionProfile,
} from "./service";

// Values are made up for the test only; the app never ships nutrition data.
let ctx: TenantContext;
let qa: TenantContext;
let units: Record<string, string>;
let flour: string; // kg
let milk: string; // l
let egg: string; // each, 1 kg = 20 each
let dishId: string;

const allFree = (except: string[]) =>
  Object.fromEntries(
    ALLERGEN_CODES.filter((c) => !except.includes(c)).map((c) => [c, "FREE_FROM"]),
  );

beforeAll(async () => {
  ({ ctx } = await createTenant("nutrition"));
  qa = (await addMember(ctx, "food_safety")).ctx;
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const product = async (sku: string, baseUomId: string) =>
    (await createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId })).id;
  flour = await product("FLOUR", units.kg);
  milk = await product("MILK", units.l);
  egg = await product("EGG", units.each);
  await addConversion(ctx, egg, { uomId: units.kg, factorToBase: "20" });
  const sauce = await createRecipe(ctx, {
    code: "BECHAMEL",
    name: "Bechamel",
    type: "PREPARATION",
    yieldQuantity: "1",
    yieldUomId: units.kg,
  });
  await addIngredient(ctx, sauce!.versionId, {
    item: `product:${flour}`,
    quantity: "0.1",
    uomId: units.kg,
  });
  await addIngredient(ctx, sauce!.versionId, {
    item: `product:${milk}`,
    quantity: "1",
    uomId: units.l,
  });
  await activateVersion(ctx, sauce!.versionId);
  const dish = await createRecipe(ctx, {
    code: "GRATIN",
    name: "Gratin",
    type: "DISH",
    yieldQuantity: "2",
    yieldUomId: units.each,
    portions: "2",
  });
  await addIngredient(ctx, dish!.versionId, {
    item: `recipe:${sauce!.id}`,
    quantity: "0.5",
    uomId: units.kg,
  });
  // Peeling waste is not eaten: 2 eggs count, not 2.22.
  await addIngredient(ctx, dish!.versionId, {
    item: `product:${egg}`,
    quantity: "2",
    uomId: units.each,
    wastePercent: "10",
  });
  await activateVersion(ctx, dish!.versionId);
  dishId = dish!.id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("nutrition and allergens", () => {
  it("knows nothing until it is told, and never guesses", async () => {
    const r = await recipeNutrition(ctx, dishId);
    expect(r.calc?.nutrition.totals.energyKcal).toBeNull();
    expect(r.calc?.nutrition.noProfile.sort()).toEqual([flour, milk, egg].sort());
    for (const c of ALLERGEN_CODES) expect(r.calc?.allergens[c].status).toBe("UNKNOWN");
    expect(r.blockers.map((b) => b.kind)).toContain("ALLERGEN_UNKNOWN");
    await expectAppError(generateLabel(ctx, dishId), "BUSINESS_RULE_VIOLATION");
  });

  it("validates profiles and free-from statements", async () => {
    const base = { basis: "PER_100G", source: "MANUAL" };
    await expectAppError(recordNutritionProfile(ctx, flour, base), "VALIDATION_FAILED");
    await expectAppError(
      recordNutritionProfile(ctx, flour, { ...base, fat: "1", saturatedFat: "2" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      recordNutritionProfile(ctx, flour, { ...base, protein: "120" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      recordNutritionProfile(ctx, flour, { ...base, source: "LAB", fat: "1" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      declareAllergens(ctx, flour, { source: "SUPPLIER_SPEC", statements: { MILK: "FREE_FROM" } }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      declareAllergens(ctx, flour, {
        source: "DATABASE",
        reference: "db",
        statements: { MILK: "FREE_FROM" },
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      declareAllergens(ctx, flour, { source: "MANUAL", statements: {} }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("rolls up through sub-recipes per portion and per allergen", async () => {
    await recordNutritionProfile(ctx, flour, {
      basis: "PER_100G",
      source: "SUPPLIER_SPEC",
      reference: "Mill spec 2026-01",
      energyKcal: "300",
      fat: "1",
      saturatedFat: "0.5",
      carbohydrate: "70",
      sugars: "1",
      protein: "10",
      salt: "0.1",
    });
    await recordNutritionProfile(ctx, milk, {
      basis: "PER_100ML",
      source: "MANUAL",
      energyKcal: "50",
      fat: "2",
      saturatedFat: "1",
      carbohydrate: "5",
      sugars: "5",
      protein: "3",
      salt: "0.1",
    });
    await recordNutritionProfile(ctx, egg, {
      basis: "PER_100G",
      source: "MANUAL",
      energyKcal: "150",
      fat: "10",
      saturatedFat: "3",
      carbohydrate: "1",
      sugars: "1",
      protein: "12",
      salt: "0.4",
    });
    await declareAllergens(ctx, flour, {
      source: "SUPPLIER_SPEC",
      reference: "Mill spec 2026-01",
      statements: { ...allFree(["GLUTEN", "SESAME"]), GLUTEN: "CONTAINS", SESAME: "MAY_CONTAIN" },
    });
    await declareAllergens(ctx, milk, {
      source: "SUPPLIER_SPEC",
      reference: "Dairy spec 7",
      statements: { ...allFree(["MILK"]), MILK: "CONTAINS" },
    });
    await declareAllergens(ctx, egg, {
      source: "SUPPLIER_SPEC",
      reference: "Farm spec 3",
      statements: { ...allFree(["EGGS"]), EGGS: "CONTAINS" },
    });

    const r = await recipeNutrition(ctx, dishId);
    const c = r.calc!;
    // Batch: 50 g flour + 500 ml milk (half a batch of sauce) + 2 eggs of 50 g.
    expect(c.nutrition.totals.energyKcal?.toFixed()).toBe("550");
    expect(c.perPortion?.energyKcal?.toFixed()).toBe("275");
    expect(c.perPortion?.fat?.toFixed()).toBe("10.25");
    expect(c.perPortion?.salt?.toFixed()).toBe("0.475");
    expect(c.per100).toBeNull(); // the dish yields portions, not a weight
    expect(c.nutrition.totals.fibre).toBeNull();
    expect(c.allergens.GLUTEN.status).toBe("CONTAINS");
    expect(c.allergens.MILK.contains).toEqual([milk]);
    expect(c.allergens.SESAME.status).toBe("MAY_CONTAIN");
    // Free-from statements are not verified yet.
    expect(c.allergens.FISH.status).toBe("UNKNOWN");
    expect(r.blockers.map((b) => b.kind)).toEqual(
      expect.arrayContaining([
        "ALLERGEN_UNKNOWN",
        "UNVERIFIED_PROFILES",
        "NO_WEIGHT_FOR_INGREDIENT_LIST",
      ]),
    );

    // A second person verifies; nobody verifies their own entries.
    await expectAppError(verifyNutritionProfile(ctx, flour), "BUSINESS_RULE_VIOLATION");
    await expectAppError(verifyAllergenDeclarations(ctx, flour), "BUSINESS_RULE_VIOLATION");
    for (const p of [flour, milk, egg]) {
      await verifyNutritionProfile(qa, p);
      expect((await verifyAllergenDeclarations(qa, p)).verified).toBe(14);
    }
    const after = (await recipeNutrition(ctx, dishId)).calc!;
    expect(after.allergens.FISH.status).toBe("FREE_FROM");
    // The ingredient list needs the milk's weight.
    expect((await recipeNutrition(ctx, dishId)).blockers.map((b) => b.kind)).toEqual([
      "NO_WEIGHT_FOR_INGREDIENT_LIST",
    ]);
    await addConversion(ctx, milk, { uomId: units.kg, factorToBase: "1" });
    expect((await recipeNutrition(ctx, dishId)).blockers).toEqual([]);

    const matrix = await allergenMatrix(ctx);
    const gratin = matrix.find((m) => m.recipe.code === "GRATIN")!;
    expect(gratin.allergens.EGGS.status).toBe("CONTAINS");
    expect(gratin.allergens.CELERY.status).toBe("FREE_FROM");
    expect(matrix.find((m) => m.recipe.code === "BECHAMEL")!.allergens.EGGS.status).toBe(
      "FREE_FROM",
    );
  });

  it("generates a label that a second person approves, and notices later changes", async () => {
    const label = await generateLabel(ctx, dishId);
    await expectAppError(generateLabel(ctx, dishId), "BUSINESS_RULE_VIOLATION");
    let view = await getLabel(ctx, label.id);
    expect(view.status).toBe("PENDING_REVIEW");
    expect(view.content.perPortion).toMatchObject({ energyKcal: "275", fat: "10", salt: "0.48" });
    expect(view.content.ingredients.map((i) => [i.sku, i.grams])).toEqual([
      ["MILK", "500"],
      ["EGG", "100"],
      ["FLOUR", "50"],
    ]);
    expect(view.content.contains).toEqual(["GLUTEN", "EGGS", "MILK"]);
    expect(view.content.mayContain).toEqual(["SESAME"]);
    expect(view.can.review).toBe(false);
    await expectAppError(
      reviewLabel(ctx, label.id, { decision: "APPROVE" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      reviewLabel(qa, label.id, { decision: "REJECT" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await reviewLabel(qa, label.id, { decision: "APPROVE", note: "Checked against specs" });
    view = await getLabel(ctx, label.id);
    expect([view.status, view.stale, view.names.reviewedBy]).toEqual([
      "APPROVED",
      false,
      expect.any(String),
    ]);
    await expectAppError(
      reviewLabel(qa, label.id, { decision: "REJECT", note: "late" }),
      "BUSINESS_RULE_VIOLATION",
    );

    // New flour values: the approved label is now out of date, and the new values need verifying.
    await recordNutritionProfile(ctx, flour, {
      basis: "PER_100G",
      source: "SUPPLIER_SPEC",
      reference: "Mill spec 2026-06",
      energyKcal: "340",
      fat: "1",
      saturatedFat: "0.5",
      carbohydrate: "72",
      sugars: "1",
      protein: "11",
      salt: "0.1",
    });
    expect((await getLabel(ctx, label.id)).stale).toBe(true);
    await expectAppError(generateLabel(ctx, dishId), "BUSINESS_RULE_VIOLATION");
    await verifyNutritionProfile(qa, flour);
    const second = await generateLabel(ctx, dishId);
    // A change after generation blocks approval.
    await declareAllergens(qa, egg, {
      source: "LAB",
      reference: "Lab 991",
      statements: { CELERY: "MAY_CONTAIN" },
    });
    await expectAppError(
      reviewLabel(qa, second.id, { decision: "APPROVE" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await reviewLabel(qa, second.id, { decision: "REJECT", note: "Egg spec changed" });
    const third = await generateLabel(ctx, dishId);
    expect((await getLabel(ctx, third.id)).content.mayContain).toEqual(["CELERY", "SESAME"]);
    await reviewLabel(qa, third.id, { decision: "APPROVE" });
    expect((await listLabels(ctx, dishId)).map((l) => [l.labelNo, l.status])).toEqual([
      [3, "APPROVED"],
      [2, "REJECTED"],
      [1, "SUPERSEDED"],
    ]);
    const egg_ = await getProductNutrition(ctx, egg);
    expect(egg_.allergens.find((a) => a.code === "CELERY")?.current?.status).toBe("MAY_CONTAIN");
    expect(egg_.declarationHistory.find((d) => d.allergen === "CELERY")?.status).toBe("FREE_FROM");
  });

  it("is limited by permission and tenant, and statements cannot be edited", async () => {
    const warehouse = (await addMember(ctx, "warehouse")).ctx;
    expect((await getProductNutrition(warehouse, flour)).profile).not.toBeNull();
    await expectAppError(
      recordNutritionProfile(warehouse, flour, { basis: "PER_100G", source: "MANUAL", fat: "1" }),
      "FORBIDDEN",
    );
    await expectAppError(generateLabel(warehouse, dishId), "FORBIDDEN");
    const procurement = (await addMember(ctx, "procurement")).ctx;
    const labelId = (await listLabels(ctx, dishId))[0].id;
    await expectAppError(reviewLabel(procurement, labelId, { decision: "APPROVE" }), "FORBIDDEN");
    const other = await createTenant("nutrition-other");
    await expectAppError(getProductNutrition(other.ctx, flour), "NOT_FOUND");
    await expectAppError(recipeNutrition(other.ctx, dishId), "NOT_FOUND");
    await expectAppError(getLabel(other.ctx, labelId), "NOT_FOUND");
    await expectAppError(
      declareAllergens(other.ctx, flour, { source: "MANUAL", statements: { MILK: "CONTAINS" } }),
      "NOT_FOUND",
    );
    const current = (await getProductNutrition(ctx, flour)).allergens.find(
      (a) => a.code === "GLUTEN",
    )!.current!;
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.allergenDeclaration.update({ where: { id: current.id }, data: { status: "FREE_FROM" } }),
      ),
    ).rejects.toThrow();
  });
});
