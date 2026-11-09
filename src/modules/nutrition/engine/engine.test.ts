import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  analyzeRecipe,
  basisQuantity,
  CalcError,
  kjFromKcal,
  saltFromSodiumMg,
  scale,
  type ValueIn,
} from "./calculate";
import { convertAmount, fdcDate, normalizeFdcFood, payloadHash, standardize } from "./normalize";

/**
 * The nutrition engine (ADR-132). Fixtures follow the shapes FoodData
 * Central documents; their figures are test values, not real foods.
 */

const full = {
  fdcId: 100001,
  dataType: "Foundation",
  description: "Test grain, cooked",
  publicationDate: "4/1/2019",
  foodCategory: { description: "Cereal Grains and Pasta" },
  ndbNumber: 20045,
  foodNutrients: [
    {
      nutrient: { id: 1008, number: "208", name: "Energy", unitName: "kcal" },
      amount: 130,
      dataPoints: 4,
      foodNutrientDerivation: { code: "NC", description: "Calculated" },
    },
    { nutrient: { id: 1003, number: "203", name: "Protein", unitName: "g" }, amount: 2.7 },
    {
      nutrient: { id: 1004, number: "204", name: "Total lipid (fat)", unitName: "g" },
      amount: 0.3,
    },
    {
      nutrient: { id: 1005, number: "205", name: "Carbohydrate, by difference", unitName: "g" },
      amount: 28,
    },
    { nutrient: { id: 1093, number: "307", name: "Sodium, Na", unitName: "mg" }, amount: 400 },
    { nutrient: { id: 1103, number: "317", name: "Selenium, Se", unitName: "UG" }, amount: 7.5 },
    { nutrient: { id: 1106, number: "320", name: "Vitamin A, RAE", unitName: "µg" } },
    {
      nutrient: { id: 1162, number: "401", name: "Vitamin C", unitName: "mg" },
      amount: 0,
      foodNutrientDerivation: { code: "Z", description: "Below limit of quantification" },
    },
    { nutrient: { id: 9999, number: "999", name: "Something new", unitName: "mg" }, amount: 1 },
  ],
  foodPortions: [
    {
      sequenceNumber: 1,
      amount: 1,
      gramWeight: 158,
      modifier: "cup",
      measureUnit: { name: "undetermined" },
    },
    { sequenceNumber: 2, amount: 250, gramWeight: 255, measureUnit: { name: "ml" } },
  ],
};

const branded = {
  fdcId: "200002",
  dataType: "Branded",
  description: "TEST JUICE",
  brandOwner: "Test Co",
  gtinUpc: "012345678905",
  ingredients: "Water, apple juice concentrate.",
  brandedFoodCategory: "Fruit & Vegetable Juice",
  servingSize: 240,
  servingSizeUnit: "ml",
  householdServingFullText: "1 cup",
  foodNutrients: [
    {
      nutrientId: 1008,
      nutrientNumber: "208",
      nutrientName: "Energy",
      unitName: "KCAL",
      value: 46,
    },
    {
      nutrientId: 2000,
      nutrientNumber: "269",
      nutrientName: "Total Sugars",
      unitName: "G",
      value: 10,
    },
  ],
};

const dictionary = [
  { id: "n-kcal", code: "energy_kcal", usdaNutrientId: 1008, usdaNumber: "208", unit: "kcal" },
  { id: "n-kj", code: "energy_kj", usdaNutrientId: 1062, usdaNumber: "268", unit: "kJ" },
  { id: "n-prot", code: "protein", usdaNutrientId: 1003, usdaNumber: "203", unit: "g" },
  { id: "n-fat", code: "fat", usdaNutrientId: 1004, usdaNumber: "204", unit: "g" },
  { id: "n-carb", code: "carbohydrate", usdaNutrientId: 1005, usdaNumber: "205", unit: "g" },
  { id: "n-na", code: "sodium", usdaNutrientId: 1093, usdaNumber: "307", unit: "mg" },
  { id: "n-salt", code: "salt", usdaNutrientId: null, usdaNumber: null, unit: "g" },
  { id: "n-se", code: "selenium", usdaNutrientId: 1103, usdaNumber: "317", unit: "µg" },
  { id: "n-a", code: "vitamin_a_rae", usdaNutrientId: 1106, usdaNumber: "320", unit: "µg" },
  { id: "n-c", code: "vitamin_c", usdaNutrientId: 1162, usdaNumber: "401", unit: "mg" },
  { id: "n-sug", code: "sugars", usdaNutrientId: 2000, usdaNumber: "269", unit: "g" },
];

describe("normalizeFdcFood (ADR-132)", () => {
  it("reads the full format with ids, units, derivations and portions", () => {
    const f = normalizeFdcFood(full)!;
    expect([f.sourceId, f.dataType, f.category, f.publicationDate, f.basis]).toEqual([
      "100001",
      "Foundation",
      "Cereal Grains and Pasta",
      "2019-04-01",
      "PER_100G",
    ]);
    expect(f.identifiers).toEqual([
      { kind: "FDC_ID", value: "100001" },
      { kind: "NDB_NUMBER", value: "20045" },
    ]);
    // Vitamin A had no amount: missing, not zero.
    expect(f.nutrients.map((n) => n.usdaNutrientId)).not.toContain(1106);
    expect(f.nutrients.find((n) => n.usdaNutrientId === 1103)?.unit).toBe("µg");
    expect(f.nutrients.find((n) => n.usdaNutrientId === 1162)?.status).toBe("BELOW_DETECTION");
    expect(f.nutrients.find((n) => n.usdaNutrientId === 1008)).toMatchObject({
      derivationCode: "NC",
      dataPoints: 4,
    });
    expect(f.portions).toEqual([
      {
        sequence: 1,
        amount: "1",
        measure: null,
        description: "1 cup",
        gramWeight: "158",
        millilitres: null,
      },
      {
        sequence: 2,
        amount: "250",
        measure: "ml",
        description: "250 ml",
        gramWeight: "255",
        millilitres: "250",
      },
    ]);
    expect(f.summary.values).toMatchObject({ energyKcal: "130", sodium: "0.4" });
    expect(f.issues).toEqual([]);
  });

  it("reads branded search results per 100 ml with barcode, ingredients and serving", () => {
    const f = normalizeFdcFood(branded)!;
    expect([f.basis, f.barcode, f.brand, f.category, f.ingredientsText]).toEqual([
      "PER_100ML",
      "012345678905",
      "Test Co",
      "Fruit & Vegetable Juice",
      "Water, apple juice concentrate.",
    ]);
    expect(f.portions).toEqual([
      {
        sequence: 0,
        amount: "240",
        measure: "ml",
        description: "1 cup (240 ml)",
        gramWeight: null,
        millilitres: "240",
      },
    ]);
    expect(f.nutrients.map((n) => [n.usdaNutrientId, n.unit, n.amount])).toEqual([
      [1008, "kcal", "46"],
      [2000, "g", "10"],
    ]);
    expect(f.issues.map((i) => i.kind)).toEqual(["MISSING_CORE_NUTRIENTS"]);
  });

  it("flags implausible values and refuses records without an id or name", () => {
    const odd = normalizeFdcFood({
      ...full,
      foodNutrients: [
        { nutrient: { id: 1003, number: "203", name: "Protein", unitName: "g" }, amount: 120 },
        { nutrient: { id: 1008, number: "208", name: "Energy", unitName: "kcal" }, amount: 950 },
      ],
    })!;
    expect(odd.issues.map((i) => i.kind)).toEqual([
      "MISSING_CORE_NUTRIENTS",
      "IMPLAUSIBLE_VALUE",
      "IMPLAUSIBLE_VALUE",
    ]);
    expect(normalizeFdcFood({ description: "x" })).toBeNull();
    expect(fdcDate("2024-10-31")).toBe("2024-10-31");
  });

  it("hashes payloads independently of key order", () => {
    expect(payloadHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      payloadHash({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
  });
});

describe("standardize (ADR-132)", () => {
  it("maps to the dictionary, converts units, adds salt and kJ as calculated, keeps unknowns", () => {
    const { values, unknown, issues } = standardize(normalizeFdcFood(full)!, dictionary);
    const by = (code: string) => values.find((v) => v.code === code)!;
    expect(by("sodium")).toMatchObject({
      amount: "400",
      originalAmount: "400",
      originalUnit: "mg",
      status: "REPORTED",
    });
    // Salt = 400 mg × 2.5 ÷ 1000 = 1 g; kJ = 130 × 4.184 = 543.92.
    expect(by("salt")).toMatchObject({ amount: "1", status: "CALCULATED", originalAmount: null });
    expect(by("energy_kj")).toMatchObject({ amount: "543.92", status: "CALCULATED" });
    expect(by("vitamin_c")).toMatchObject({
      status: "BELOW_DETECTION",
      amount: null,
      originalAmount: "0",
    });
    expect(values.some((v) => v.code === "vitamin_a_rae")).toBe(false);
    expect(unknown.map((u) => u.usdaNutrientId)).toEqual([9999]);
    expect(issues).toEqual([]);
  });

  it("reports a unit it cannot convert instead of guessing", () => {
    const f = normalizeFdcFood({
      ...full,
      foodNutrients: [
        { nutrient: { id: 1003, number: "203", name: "Protein", unitName: "kcal" }, amount: 5 },
      ],
    })!;
    const r = standardize(f, dictionary);
    expect(r.values[0]).toMatchObject({ amount: null, originalUnit: "kcal", unit: "g" });
    expect(r.issues.map((i) => i.kind)).toEqual(["UNIT_MISMATCH"]);
    expect(convertAmount("1500", "µg", "mg")?.toFixed()).toBe("1.5");
    expect(convertAmount("1", "IU", "µg")).toBeNull();
  });
});

describe("calculations (ADR-132)", () => {
  const per100: ValueIn[] = [
    { code: "energy_kcal", unit: "kcal", amount: "130", status: "REPORTED" },
    { code: "protein", unit: "g", amount: "2.7", status: "REPORTED" },
    { code: "vitamin_c", unit: "mg", amount: null, status: "BELOW_DETECTION" },
  ];
  const grain = {
    basis: "PER_100G" as const,
    portions: [
      { id: "cup", gramWeight: "158", millilitres: null },
      { id: "ml250", gramWeight: "255", millilitres: "250" },
    ],
  };

  it("scales per 100 g to a serving", () => {
    // 30 g: 130 × 30 / 100 = 39 kcal; 2.7 × 0.3 = 0.81 g.
    expect(scale(per100, basisQuantity(grain, "30", "g").basis)).toEqual([
      { code: "energy_kcal", unit: "kcal", amount: "39", status: "REPORTED" },
      { code: "protein", unit: "g", amount: "0.81", status: "REPORTED" },
      { code: "vitamin_c", unit: "mg", amount: null, status: "BELOW_DETECTION" },
    ]);
    expect(basisQuantity(grain, "2", "portion", "cup").grams?.toFixed()).toBe("316");
    expect(basisQuantity(grain, "1", "oz").basis.toFixed()).toBe("28.349523125");
  });

  it("converts volume only with the food's own density", () => {
    // Density 255 g / 250 ml = 1.02 g/ml: 100 ml = 102 g.
    expect(basisQuantity(grain, "100", "ml").grams?.toFixed()).toBe("102");
    const noDensity = { basis: "PER_100G" as const, portions: [] };
    expect(() => basisQuantity(noDensity, "100", "ml")).toThrow(CalcError);
    const juice = { basis: "PER_100ML" as const, portions: [] };
    expect(basisQuantity(juice, "0.25", "l").basis.toFixed()).toBe("250");
    expect(() => basisQuantity(juice, "100", "g")).toThrow(/density/);
    expect(() => basisQuantity(grain, "-1", "g")).toThrow(CalcError);
  });

  it("converts energy and sodium exactly", () => {
    expect(kjFromKcal(new Decimal(100)).toFixed()).toBe("418.4");
    expect(saltFromSodiumMg(new Decimal(400)).toFixed()).toBe("1");
  });

  it("totals a recipe, per serving and per 100 g finished, keeping gaps visible", () => {
    const r = analyzeRecipe({
      ingredients: [
        {
          ref: "a",
          label: "Grain",
          values: per100,
          basisQty: new Decimal(200),
          grams: new Decimal(200),
        },
        {
          ref: "b",
          label: "Oil",
          values: [
            { code: "energy_kcal", unit: "kcal", amount: "884", status: "REPORTED" },
            { code: "vitamin_c", unit: "mg", amount: null, status: "NOT_APPLICABLE" },
          ],
          basisQty: new Decimal(10),
          grams: new Decimal(10),
        },
      ],
      codes: [
        { code: "energy_kcal", unit: "kcal" },
        { code: "protein", unit: "g" },
        { code: "vitamin_c", unit: "mg" },
      ],
      servings: 2,
      finishedGrams: "180",
    });
    // Energy: 260 + 88.4 = 348.4 kcal; per serving 174.2; per 100 g of 180 g finished 193.5556.
    expect(r.total[0]).toMatchObject({ amount: "348.4", complete: true });
    expect(r.perServing?.[0].amount).toBe("174.2");
    expect(r.per100g?.[0].amount).toBe("193.5556");
    // Protein: the oil has none recorded — unknown total, known part shown.
    expect(r.total[1]).toMatchObject({ amount: null, knownAmount: "5.4", missingIn: ["Oil"] });
    // Vitamin C: below detection in the grain, not applicable to the oil.
    expect(r.total[2]).toMatchObject({ amount: null, belowDetectionIn: ["Grain"], missingIn: [] });
    expect([r.totalGrams, r.finishedGrams, r.yieldFromRawWeight]).toEqual(["210", "180", false]);
  });
});
