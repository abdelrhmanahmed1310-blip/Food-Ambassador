import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  getReferenceFood,
  importLibraryFile,
  linkReferenceFood,
  listLibraryImports,
  listReferenceFoods,
} from "./library";
import { declareAllergens, getProductNutrition, recordNutritionProfile } from "./service";

// Files follow each source's JSON shape; values are placeholders for the test.
const usda = JSON.stringify({
  FoundationFoods: [
    {
      fdcId: 900001,
      description: "Test chickpeas, dry",
      dataType: "Foundation",
      foodNutrients: [
        { nutrient: { number: "208", unitName: "kcal" }, amount: 350 },
        { nutrient: { number: "204", unitName: "g" }, amount: 6 },
        { nutrient: { number: "606", unitName: "g" }, amount: 0.6 },
        { nutrient: { number: "205", unitName: "g" }, amount: 60 },
        { nutrient: { number: "269", unitName: "g" }, amount: 10 },
        { nutrient: { number: "203", unitName: "g" }, amount: 20 },
        { nutrient: { number: "307", unitName: "mg" }, amount: 24 },
      ],
    },
    {
      fdcId: 900002,
      description: "Test oddity",
      dataType: "SR Legacy",
      foodNutrients: [
        { nutrient: { number: "204", unitName: "g" }, amount: 1 },
        { nutrient: { number: "606", unitName: "g" }, amount: 5 },
      ],
    },
    { description: "no id" },
  ],
});
const off = JSON.stringify({
  code: "0000000000031",
  product: {
    product_name: "Test tahini",
    product_name_ar: "طحينة تجريبية",
    product_quantity_unit: "g",
    nutriments: { "energy-kcal_100g": 600, fat_100g: 50, salt_100g: 0.1 },
    allergens_tags: ["en:sesame-seeds"],
    traces_tags: ["en:peanuts", "en:milk"],
  },
});
const wikidata = JSON.stringify({
  entities: {
    Q100: { id: "Q100", labels: { en: { value: "test chickpea" }, ar: { value: "حمص تجريبي" } } },
  },
});

let ctx: TenantContext;
let chickpeas: string;
let tahini: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("library"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  chickpeas = (
    await createProduct(ctx, {
      sku: "CHICKPEA",
      nameEn: "Chickpeas",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  tahini = (
    await createProduct(ctx, {
      sku: "TAHINI",
      nameEn: "Tahini",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("ingredient library", () => {
  it("imports each source once, with licence and provenance", async () => {
    const r = await importLibraryFile(ctx, {
      source: "USDA_FDC",
      fileName: "fdc.json",
      content: usda,
    });
    expect(r).toMatchObject({ alreadyImported: false, created: 2, updated: 0, skipped: 1 });
    expect(
      await importLibraryFile(ctx, { source: "USDA_FDC", fileName: "again.json", content: usda }),
    ).toMatchObject({
      alreadyImported: true,
      created: 0,
    });
    await importLibraryFile(ctx, { source: "OPEN_FOOD_FACTS", fileName: "off.json", content: off });
    await importLibraryFile(ctx, { source: "WIKIDATA", fileName: "Q100.json", content: wikidata });
    await expectAppError(
      importLibraryFile(ctx, { source: "WIKIDATA", fileName: "x.json", content: "{}" }),
      "BUSINESS_RULE_VIOLATION",
    );
    // A changed record in a later file updates the copy.
    const changed = usda.replace('"amount":350', '"amount":355');
    expect(
      await importLibraryFile(ctx, {
        source: "USDA_FDC",
        fileName: "fdc-2.json",
        content: changed,
      }),
    ).toMatchObject({
      created: 0,
      updated: 2,
    });
    const list = await listReferenceFoods(ctx, { q: "test" });
    expect(list.total).toBe(4);
    expect((await listReferenceFoods(ctx, { source: "OPEN_FOOD_FACTS" })).items[0]).toMatchObject({
      name: "Test tahini",
      allergens: ["SESAME"],
    });
    const fdc = (await listReferenceFoods(ctx, { q: "900001" })).items[0];
    const food = await getReferenceFood(ctx, fdc.id);
    expect([food.energyKcal?.toFixed(), food.sodium?.toFixed(), food.salt, food.licence]).toEqual([
      "355",
      "0.024",
      null,
      "CC0 1.0 (public domain)",
    ]);
    expect((await listLibraryImports(ctx)).map((i) => i.source)).toEqual([
      "USDA_FDC",
      "WIKIDATA",
      "OPEN_FOOD_FACTS",
      "USDA_FDC",
    ]);
  });

  it("links a record to a product as unverified database data, never as free from", async () => {
    const find = async (q: string) => (await listReferenceFoods(ctx, { q })).items[0].id;
    const fdc = await find("900001");
    await linkReferenceFood(ctx, fdc, { productId: chickpeas, nutrition: "on" });
    let n = await getProductNutrition(ctx, chickpeas);
    expect(n.profile).toMatchObject({
      source: "DATABASE",
      reference: "USDA FDC 900001 (Foundation)",
      verifiedAt: null,
    });
    expect(n.profile?.energyKcal?.toFixed()).toBe("355");
    expect(n.profile?.salt).toBeNull();
    // Values that fail the plausibility checks are not copied.
    await expectAppError(
      linkReferenceFood(ctx, await find("900002"), { productId: chickpeas, nutrition: "on" }),
      "BUSINESS_RULE_VIOLATION",
    );

    // Wikidata fills in a missing Arabic name only.
    await linkReferenceFood(ctx, await find("Q100"), { productId: chickpeas, arabicName: "on" });
    n = await getProductNutrition(ctx, chickpeas);
    expect(n.product.nameAr).toBe("حمص تجريبي");

    // Open Food Facts: sesame contains, peanut may contain; a contradiction with a statement is reported.
    await declareAllergens(ctx, tahini, {
      source: "SUPPLIER_SPEC",
      reference: "Spec 1",
      statements: { MILK: "FREE_FROM" },
    });
    const r = await linkReferenceFood(ctx, await find("0000000000031"), {
      productId: tahini,
      nutrition: "on",
      allergens: "on",
    });
    expect(r).toMatchObject({
      nutrition: true,
      allergens: ["SESAME", "PEANUTS"],
      conflicts: ["MILK"],
    });
    const t = await getProductNutrition(ctx, tahini);
    const status = (code: string) => t.allergens.find((a) => a.code === code)?.current;
    expect(status("SESAME")).toMatchObject({ status: "CONTAINS", source: "DATABASE" });
    expect(status("PEANUTS")?.status).toBe("MAY_CONTAIN");
    expect(status("MILK")?.status).toBe("FREE_FROM");
    expect(status("FISH")).toBeNull();
    expect((await getReferenceFood(ctx, await find("0000000000031"))).linkedProduct?.id).toBe(
      tahini,
    );

    // A specification profile is not replaced by a database record.
    await recordNutritionProfile(ctx, tahini, {
      basis: "PER_100G",
      source: "SUPPLIER_SPEC",
      reference: "Spec 2",
      fat: "51",
    });
    await expectAppError(
      linkReferenceFood(ctx, await find("0000000000031"), { productId: tahini, nutrition: "on" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      linkReferenceFood(ctx, fdc, { productId: tahini }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("is limited by permission and tenant", async () => {
    const warehouse = (await addMember(ctx, "warehouse")).ctx;
    expect((await listReferenceFoods(warehouse)).total).toBeGreaterThan(0);
    await expectAppError(
      importLibraryFile(warehouse, { source: "WIKIDATA", fileName: "w.json", content: wikidata }),
      "FORBIDDEN",
    );
    const id = (await listReferenceFoods(ctx)).items[0].id;
    await expectAppError(
      linkReferenceFood(warehouse, id, { productId: chickpeas, nutrition: "on" }),
      "FORBIDDEN",
    );
    const other = await createTenant("library-other");
    expect((await listReferenceFoods(other.ctx)).total).toBe(0);
    await expectAppError(getReferenceFood(other.ctx, id), "NOT_FOUND");
    await expectAppError(
      linkReferenceFood(other.ctx, id, { productId: chickpeas, nutrition: "on" }),
      "NOT_FOUND",
    );
    // The same file in another organization is its own import.
    expect(
      (
        await importLibraryFile(other.ctx, {
          source: "WIKIDATA",
          fileName: "w.json",
          content: wikidata,
        })
      ).alreadyImported,
    ).toBe(false);
  });
});
