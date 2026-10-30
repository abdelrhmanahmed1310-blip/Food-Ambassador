import { describe, expect, it } from "vitest";
import {
  parseLibraryFile,
  parseOpenFoodFacts,
  parseUsdaFdc,
  parseWikidata,
} from "./library-parsers";

// Fixtures follow each source's published JSON shape; the numbers are placeholders for the test.

describe("USDA FoodData Central", () => {
  it("reads download files and API responses by nutrient number and unit", () => {
    const download = {
      FoundationFoods: [
        {
          fdcId: 100001,
          description: "Test food, raw",
          dataType: "Foundation",
          foodCategory: { description: "Vegetables" },
          foodNutrients: [
            {
              nutrient: {
                number: "958",
                name: "Energy (Atwater Specific Factors)",
                unitName: "kcal",
              },
              amount: 21.5,
            },
            { nutrient: { number: "204", name: "Total lipid (fat)", unitName: "g" }, amount: 0.25 },
            { nutrient: { number: "203", name: "Protein", unitName: "g" }, amount: 1.123456 },
            { nutrient: { number: "307", name: "Sodium, Na", unitName: "mg" }, amount: 12 },
            {
              nutrient: { number: "205.2", name: "Carbohydrate, by summation", unitName: "g" },
              amount: 3,
            },
            { nutrient: { number: "291", name: "Fiber", unitName: "mg" }, amount: 900 },
          ],
        },
        { description: "No id" },
      ],
    };
    const r = parseUsdaFdc(download);
    expect(r.problems).toEqual([{ index: 1, reason: "missingIdOrName" }]);
    const f = r.foods[0];
    expect(f).toMatchObject({
      sourceId: "100001",
      dataType: "Foundation",
      name: "Test food, raw",
      description: "Vegetables",
      basis: "PER_100G",
      values: {
        energyKcal: "21.5",
        fat: "0.25",
        protein: "1.1235",
        sodium: "0.012",
        carbohydrate: "3",
      },
      sourceUrl: "https://fdc.nal.usda.gov/food-details/100001/nutrients",
    });
    // Never derived: no salt from sodium; a nutrient in an unexpected unit is left out.
    expect(f.values.salt).toBeUndefined();
    expect(f.values.fibre).toBeUndefined();
    expect(f.notes.join(" | ")).toMatch(/Atwater specific.*by summation.*291 in mg/);
    expect(f.allergens).toEqual([]);

    const search = {
      foods: [
        {
          fdcId: 200002,
          description: "Test drink",
          dataType: "Branded",
          brandOwner: "Test Co",
          servingSizeUnit: "ml",
          foodNutrients: [
            { nutrientNumber: "208", nutrientName: "Energy", unitName: "KCAL", value: 40 },
            { nutrientNumber: "958", nutrientName: "Energy", unitName: "KCAL", value: 99 },
            { nutrientNumber: "269", nutrientName: "Sugars", unitName: "G", value: 10 },
          ],
        },
      ],
    };
    expect(parseUsdaFdc(search).foods[0]).toMatchObject({
      basis: "PER_100ML",
      brand: "Test Co",
      values: { energyKcal: "40", sugars: "10" },
      notes: [],
    });
    expect(parseUsdaFdc({}).problems).toEqual([{ index: -1, reason: "noFoods" }]);
    expect(parseLibraryFile("USDA_FDC", "not json").problems[0].reason).toBe("notJson");
  });
});

describe("Open Food Facts", () => {
  const product = {
    code: "0000000000017",
    product: {
      product_name: "Test spread",
      product_name_ar: "دهن تجريبي",
      brands: "Brand",
      quantity: "350 g",
      product_quantity_unit: "g",
      nutriments: {
        "energy-kcal_100g": 500,
        fat_100g: "30.5",
        salt_100g: 0.1,
        sodium_100g: 0.04,
        sugars_100g: -1,
      },
      allergens_tags: ["en:milk", "en:nuts", "en:something-else"],
      traces_tags: ["en:peanuts", "en:milk"],
    },
  };

  it("maps per-100 values and allergen tags, and never reads absence as free from", () => {
    const r = parseOpenFoodFacts(JSON.stringify(product));
    expect(r.problems).toEqual([]);
    expect(r.foods[0]).toMatchObject({
      sourceId: "0000000000017",
      nameAr: "دهن تجريبي",
      basis: "PER_100G",
      values: { energyKcal: "500", fat: "30.5", salt: "0.1", sodium: "0.04" },
      allergens: ["MILK", "TREE_NUTS"],
      traces: ["PEANUTS"],
      unmappedTags: ["en:something-else"],
    });
    expect(r.foods[0].values.sugars).toBeUndefined();
    const none = parseOpenFoodFacts(
      JSON.stringify({
        products: [{ code: "1234567", product_name: "Juice", quantity: "1 l", nutriments: {} }],
      }),
    );
    expect(none.foods[0]).toMatchObject({ basis: null, allergens: [] });
    expect(none.foods[0].notes).toContain("no allergens listed — this does not mean free from");
  });

  it("reads JSON Lines from the dump and reports bad lines", () => {
    const lines = [
      JSON.stringify({
        code: "7654321",
        product_name: "Milk drink",
        product_quantity_unit: "ml",
        nutriments: { proteins_100g: 3 },
      }),
      "{broken",
      JSON.stringify({ code: "abc", product_name: "No barcode" }),
    ].join("\n");
    const r = parseOpenFoodFacts(lines);
    expect(r.foods.map((f) => [f.sourceId, f.basis])).toEqual([["7654321", "PER_100ML"]]);
    expect(r.problems).toEqual([
      { index: 1, reason: "notAnObject" },
      { index: 2, reason: "missingBarcode" },
    ]);
  });
});

describe("Wikidata", () => {
  it("takes English and Arabic labels from entity JSON", () => {
    const r = parseWikidata({
      entities: {
        Q1: {
          id: "Q1",
          labels: {
            en: { language: "en", value: "test fruit" },
            ar: { language: "ar", value: "فاكهة تجريبية" },
          },
          descriptions: { en: { language: "en", value: "a test entity" } },
        },
        Q2: { id: "Q2", labels: { fr: { value: "seulement" } } },
      },
    });
    expect(r.foods).toEqual([
      expect.objectContaining({
        sourceId: "Q1",
        name: "test fruit",
        nameAr: "فاكهة تجريبية",
        basis: null,
        values: {},
      }),
    ]);
    expect(r.problems).toEqual([{ index: 1, reason: "missingIdOrName" }]);
  });
});
