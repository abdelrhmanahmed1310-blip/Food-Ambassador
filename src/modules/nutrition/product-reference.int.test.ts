import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBarcode, createProduct, listProducts, listUnits } from "@/modules/catalog/service";
import { importProducts } from "@/modules/inventory/csv";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { createFood, getFood, importUsdaFoods } from "./engine/foods";
import { ProviderError, setTestProvider, type FoodProvider } from "./engine/providers";
import {
  confirmReferenceLinks,
  importReferenceLinks,
  productReference,
  referenceCoverage,
  unlinkProductReference,
  unmatchedProducts,
  chooseProductReference,
} from "./product-reference";
import { getProductNutrition, recordNutritionProfile } from "./service";

/**
 * Products linked to library foods for their full nutrient profiles
 * (ADR-136). USDA is a stand-in following FoodData Central's documented
 * shapes, with test values.
 */

const nutrient = (id: number, number: string, name: string, unitName: string, amount: number) => ({
  nutrient: { id, number, name, unitName },
  amount,
});
const usda: Record<string, unknown> = {
  "400001": {
    fdcId: 400001,
    dataType: "SR Legacy",
    description: "Testrice, white, long-grain, raw",
    publicationDate: "2019-04-01",
    foodNutrients: [
      nutrient(1008, "208", "Energy", "kcal", 365),
      nutrient(1003, "203", "Protein", "g", 7.1),
      nutrient(1004, "204", "Total lipid (fat)", "g", 0.7),
      nutrient(1005, "205", "Carbohydrate, by difference", "g", 80),
      nutrient(1089, "303", "Iron, Fe", "mg", 0.8),
      nutrient(1090, "304", "Magnesium, Mg", "mg", 25),
    ],
  },
  "400002": {
    fdcId: 400002,
    dataType: "Branded",
    description: "TESTJUICE ORANGE",
    gtinUpc: "012345678905",
    publicationDate: "2024-05-01",
    foodNutrients: [nutrient(1008, "208", "Energy", "KCAL", 45)],
  },
  "400003": {
    fdcId: 400003,
    dataType: "Foundation",
    description: "Testlentils, red, raw",
    publicationDate: "2024-04-01",
    foodNutrients: [
      nutrient(1008, "208", "Energy", "kcal", 358),
      nutrient(1003, "203", "Protein", "g", 24),
    ],
  },
};
const fake: FoodProvider = {
  id: "USDA_FDC",
  configured: () => true,
  async search() {
    return { total: 0, foods: [] };
  },
  async food(id) {
    if (!usda[id]) throw new ProviderError("NOT_FOUND", "Not found in USDA FoodData Central");
    return usda[id];
  },
  async foods(ids) {
    return ids.map((i) => usda[i]).filter(Boolean);
  },
  async latestPublished() {
    return null;
  },
  async ping() {
    return { ok: true, ms: 1 };
  },
};

let ctx: TenantContext;
let each: string;
let riceFood: string;
let juiceFood: string;
const product = async (sku: string, nameEn: string, type = "RAW_MATERIAL") =>
  (await createProduct(ctx, { sku, nameEn, type, baseUomId: each })).id;

beforeAll(async () => {
  ({ ctx } = await createTenant("product-reference"));
  setTestProvider(fake);
  each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  const r = await importUsdaFoods(ctx, ["400001", "400002"]);
  riceFood = r.foods.find((f) => f.result === "created")!.foodId;
  juiceFood = r.foods[1].foodId;
});

afterAll(async () => {
  setTestProvider(null);

  await getDb().$disconnect();
});

describe("product ↔ library food (ADR-136)", () => {
  it("suggests foods by barcode, then by the food words of the name; links only on confirmation", async () => {
    const small = await product("TRICE-5", "Testrice white 5kg bag");
    const big = await product("TRICE-25", "Testrice white long grain 25 kg sack");
    const juice = await product("TJUICE", "Fresh drink 1L", "FINISHED_GOOD");
    await addBarcode(ctx, juice, { barcode: "012345678905", symbology: "UPC_A" });
    await product("TBOX", "Testrice box", "PACKAGING");

    const list = await unmatchedProducts(ctx);
    const row = (sku: string) => list.items.find((i) => i.product.sku === sku)!;
    expect(row("TRICE-5").candidates[0]).toMatchObject({ id: riceFood, match: "NAME" });
    expect(row("TRICE-25").candidates[0].id).toBe(riceFood);
    // The juice's name says nothing, but its barcode is the USDA branded record's.
    expect(row("TJUICE").candidates[0]).toMatchObject({ id: juiceFood, match: "BARCODE" });
    // Packaging is not a food product.
    expect(list.items.some((i) => i.product.sku === "TBOX")).toBe(false);
    // Suggestions changed nothing.
    expect(await referenceCoverage(ctx)).toEqual({ linked: 0, unlinked: 3 });

    // One generic food for two pack sizes.
    const r = await confirmReferenceLinks(ctx, [
      { productId: small, foodId: riceFood },
      { productId: big, foodId: riceFood },
    ]);
    expect(r).toEqual({ linked: 2, valuesCopied: 2, specKept: 0, allergenConflicts: 0 });
    expect(await referenceCoverage(ctx)).toEqual({ linked: 2, unlinked: 1 });
    expect((await getFood(ctx, riceFood)).linkedProducts.map((p) => p.sku).sort()).toEqual([
      "TRICE-25",
      "TRICE-5",
    ]);
    const ref = await productReference(ctx, small);
    expect(ref.food).toMatchObject({ id: riceFood, source: "USDA_FDC", sourceId: "400001" });
    // The full profile, not only label values: iron and magnesium are there.
    expect(ref.food!.nutrients).toBeGreaterThanOrEqual(6);
    expect(ref.core.find((v) => v.code === "protein")?.amount).toBe("7.1");
    // Label values were copied as unverified database data.
    expect((await getProductNutrition(ctx, small)).profile).toMatchObject({
      source: "DATABASE",
      referenceFoodId: riceFood,
      verifiedAt: null,
    });
    expect((await listProducts(ctx, { nutrition: "unlinked" })).items.map((p) => p.sku)).toEqual(
      expect.arrayContaining(["TJUICE"]),
    );
    expect(
      (await listProducts(ctx, { nutrition: "linked" })).items.map((p) => p.sku).sort(),
    ).toEqual(["TRICE-25", "TRICE-5"]);
  });

  it("never replaces specification values; unlinking removes only what was copied", async () => {
    const oil = await product("TOIL", "Testoil sunflower");
    await recordNutritionProfile(ctx, oil, {
      basis: "PER_100G",
      source: "SUPPLIER_SPEC",
      reference: "Spec 7",
      fat: "100",
    });
    const r = await confirmReferenceLinks(ctx, [{ productId: oil, foodId: riceFood }]);
    expect(r).toMatchObject({ linked: 1, valuesCopied: 0, specKept: 1 });
    expect((await getProductNutrition(ctx, oil)).profile?.source).toBe("SUPPLIER_SPEC");
    await unlinkProductReference(ctx, oil);
    expect((await productReference(ctx, oil)).food).toBeNull();
    expect((await getProductNutrition(ctx, oil)).profile?.source).toBe("SUPPLIER_SPEC");

    const small = (
      await getDb().product.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, sku: "TRICE-5" },
      })
    ).id;
    await unlinkProductReference(ctx, small);
    // The copied database values went with the link.
    expect((await getProductNutrition(ctx, small)).profile).toBeNull();
    expect((await getFood(ctx, riceFood)).linkedProducts.map((p) => p.sku)).toEqual(["TRICE-25"]);
  });

  it("links from the product's page, fetching a USDA record into the library first", async () => {
    const lentils = await product("TLENT", "Testlentils red");
    const r = await chooseProductReference(ctx, lentils, { fdcId: "400003" });
    expect(r).toMatchObject({ reference: true, nutrition: true });
    expect((await productReference(ctx, lentils)).food).toMatchObject({ sourceId: "400003" });
    await expectAppError(
      chooseProductReference(ctx, lentils, { fdcId: "499999" }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("links new products from the product upload, all or nothing", async () => {
    const before = await getDb().product.count({ where: { organizationId: ctx.organizationId } });
    const bad = await importProducts(
      ctx,
      [
        "sku,name_en,type,base_unit,reference_source,reference_id",
        "TUP-1,Upload rice,RAW_MATERIAL,each,USDA,400001",
        "TUP-2,Upload x,RAW_MATERIAL,each,nutritionix,1",
        "TUP-3,Upload y,RAW_MATERIAL,each,USDA_FDC,499999",
        "TUP-4,Upload z,RAW_MATERIAL,each,USDA_FDC,",
      ].join("\n"),
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => `${e.row}:${e.column}:${e.message}`)).toEqual([
      "2:reference_source:referenceSourceUnknown",
      "4:reference_id:referenceIncomplete",
    ]);
    // With the format problems fixed, an id USDA does not have is reported.
    const missing = await importProducts(
      ctx,
      "sku,name_en,type,base_unit,reference_source,reference_id\nTUP-3,Upload y,RAW_MATERIAL,each,USDA_FDC,499999",
    );
    expect(missing.errors).toEqual([
      { row: 1, column: "reference_id", message: "referenceNotFound" },
    ]);
    expect(await getDb().product.count({ where: { organizationId: ctx.organizationId } })).toBe(
      before,
    );

    const good = await importProducts(
      ctx,
      [
        "sku,name_en,type,base_unit,reference_source,reference_id",
        "TUP-1,Upload rice,RAW_MATERIAL,each,USDA,400001",
        "TUP-5,Upload plain,RAW_MATERIAL,each,,",
      ].join("\n"),
    );
    expect(good).toMatchObject({ ok: true, imported: 2, linked: 1 });
    const up = await getDb().product.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, sku: "TUP-1" },
    });
    expect(up.referenceFoodId).toBe(riceFood);
  });

  it("links existing products from a links file", async () => {
    const own = await createFood(ctx, {
      name: "Testtahini house recipe",
      basis: "PER_100G",
      values: { energy_kcal: "595", fat: "54", protein: "17" },
    });
    const ownSourceId = (await getFood(ctx, own.id)).food.sourceId;
    await product("TTAH", "Tahini");
    const bad = await importReferenceLinks(
      ctx,
      `sku,reference_source,reference_id\nNOPE,MANUAL,${ownSourceId}\nTTAH,MANUAL,M-doesnotexist`,
    );
    expect(bad.errors.map((e) => `${e.row}:${e.message}`)).toEqual([
      "1:unknownSku",
      "2:referenceNotFound",
    ]);
    const ok = await importReferenceLinks(
      ctx,
      `sku,reference_source,reference_id\nttah,library,${ownSourceId}`,
    );
    expect(ok).toMatchObject({ ok: true, imported: 1, linked: 1, valuesCopied: 1 });
    expect((await importReferenceLinks(ctx, "sku,reference_id\nX,1")).errors[0]).toMatchObject({
      column: "reference_source",
      message: "csvMissingColumn",
    });
  });

  it("keeps organizations apart and checks permission", async () => {
    const other = (await createTenant("product-reference-other")).ctx;
    const small = (
      await getDb().product.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, sku: "TRICE-25" },
      })
    ).id;
    await expectAppError(productReference(other, small), "NOT_FOUND");
    await expectAppError(
      confirmReferenceLinks(other, [{ productId: small, foodId: riceFood }]),
      "NOT_FOUND",
    );
    const analyst = (await addMember(ctx, "analyst", {}, "reference-analyst")).ctx;
    await expectAppError(
      confirmReferenceLinks(analyst, [{ productId: small, foodId: riceFood }]),
      "FORBIDDEN",
    );
    await expectAppError(unlinkProductReference(analyst, small), "FORBIDDEN");
  });
});
