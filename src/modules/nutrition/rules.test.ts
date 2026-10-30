import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import type { UnitDef } from "@/modules/catalog/units";
import type { VersionInput } from "@/modules/recipes/costing";
import {
  basisAmountPerBaseUnit,
  reachedProducts,
  rollupAllergens,
  rollupNutrition,
  roundForLabel,
  type ProfileInput,
} from "./rules";

const d = (v: string) => new Decimal(v);
const kg: UnitDef = { id: "kg", code: "kg", dimension: "MASS", factorToBase: "1000" };
const l: UnitDef = { id: "l", code: "l", dimension: "VOLUME", factorToBase: "1000" };
const each: UnitDef = { id: "each", code: "each", dimension: "COUNT", factorToBase: "1" };
const units = new Map([kg, l, each].map((u) => [u.id, u]));
const flour = { id: "flour", base: kg, conversions: [] };
const milk = { id: "milk", base: l, conversions: [] };
// A product-specific conversion: 1 kg = 50 each, so one weighs 20 g.
const egg = { id: "egg", base: each, conversions: [{ uomId: "kg", factorToBase: d("50") }] };
const plate = { id: "plate", base: each, conversions: [] };
const products = new Map([flour, milk, egg, plate].map((p) => [p.id, p]));

const profile = (
  id: string,
  values: ProfileInput["values"],
  extra: Partial<ProfileInput> = {},
): ProfileInput => ({
  id,
  basis: "PER_100G",
  verified: true,
  values,
  ...extra,
});

describe("amount of the nutrition basis in a base unit", () => {
  it("uses the base unit or a product conversion, never a guess", () => {
    expect(basisAmountPerBaseUnit(flour, "PER_100G", units)?.toFixed()).toBe("1000");
    expect(basisAmountPerBaseUnit(milk, "PER_100ML", units)?.toFixed()).toBe("1000");
    expect(basisAmountPerBaseUnit(milk, "PER_100G", units)).toBeNull();
    expect(basisAmountPerBaseUnit(egg, "PER_100G", units)?.toFixed()).toBe("20");
    expect(basisAmountPerBaseUnit(plate, "PER_100G", units)).toBeNull();
  });
});

describe("nutrition roll-up", () => {
  const profiles = new Map([
    ["flour", profile("p1", { energyKcal: d("364"), fat: d("1"), protein: d("10"), salt: d("0") })],
    [
      "milk",
      profile(
        "p2",
        { energyKcal: d("64"), fat: d("3.6"), protein: d("3.3"), salt: null },
        { basis: "PER_100ML", verified: false },
      ),
    ],
  ]);

  it("sums per nutrient and leaves a nutrient unknown if any ingredient lacks it", () => {
    const r = rollupNutrition({
      usage: new Map([
        ["flour", d("0.5")],
        ["milk", d("0.25")],
      ]),
      products,
      profiles,
      units,
      incomplete: false,
    });
    expect(r.totals.energyKcal?.toFixed()).toBe("1980"); // 5 × 364 + 2.5 × 64
    expect(r.totals.fat?.toFixed()).toBe("14");
    expect(r.totals.protein?.toFixed()).toBe("58.25");
    expect(r.totals.salt).toBeNull();
    expect(r.missing.salt).toEqual(["milk"]);
    expect(r.totals.sugars).toBeNull();
    expect(r.missing.sugars).toEqual(["flour", "milk"]);
    expect(r.unverified).toEqual(["milk"]);
    expect(r.grams.get("flour")?.toFixed()).toBe("500");
    expect(r.grams.has("milk")).toBe(false);
  });

  it("marks products without a profile or conversion, and an incomplete recipe as unknown", () => {
    const r = rollupNutrition({
      usage: new Map([
        ["flour", d("1")],
        ["plate", d("2")],
      ]),
      products,
      profiles: new Map([...profiles, ["plate", profile("p3", { energyKcal: d("0") })]]),
      units,
      incomplete: false,
    });
    expect(r.noConversion).toEqual(["plate"]);
    expect(r.totals.energyKcal).toBeNull();
    const none = rollupNutrition({
      usage: new Map([["egg", d("2")]]),
      products,
      profiles,
      units,
      incomplete: false,
    });
    expect(none.noProfile).toEqual(["egg"]);
    expect(none.grams.get("egg")?.toFixed()).toBe("40");
    const partial = rollupNutrition({
      usage: new Map([["flour", d("1")]]),
      products,
      profiles,
      units,
      incomplete: true,
    });
    expect(partial.totals.energyKcal).toBeNull();
  });
});

describe("allergen roll-up", () => {
  const decl = (entries: Record<string, Record<string, [string, boolean]>>) =>
    new Map(
      Object.entries(entries).map(([p, a]) => [
        p,
        new Map(
          Object.entries(a).map(([code, [status, verified]]) => [code, { status, verified }]),
        ),
      ]),
    ) as Parameters<typeof rollupAllergens>[0]["declarations"];

  it("contains beats may contain beats unknown; free from needs every ingredient verified", () => {
    const declarations = decl({
      flour: {
        GLUTEN: ["CONTAINS", false],
        MILK: ["FREE_FROM", true],
        EGGS: ["FREE_FROM", true],
        FISH: ["FREE_FROM", true],
      },
      milk: {
        MILK: ["CONTAINS", true],
        GLUTEN: ["MAY_CONTAIN", true],
        EGGS: ["FREE_FROM", false],
        FISH: ["FREE_FROM", true],
      },
    });
    const r = rollupAllergens({ productIds: ["flour", "milk"], declarations, incomplete: false });
    expect(r.GLUTEN).toMatchObject({
      status: "CONTAINS",
      contains: ["flour"],
      mayContain: ["milk"],
    });
    expect(r.MILK.status).toBe("CONTAINS");
    expect(r.EGGS).toMatchObject({ status: "UNKNOWN", unknown: ["milk"] });
    expect(r.FISH.status).toBe("FREE_FROM");
    expect(r.SESAME).toMatchObject({ status: "UNKNOWN", unknown: ["flour", "milk"] });
    // A part of the recipe that could not be expanded removes every "free from".
    expect(
      rollupAllergens({ productIds: ["flour", "milk"], declarations, incomplete: true }).FISH
        .status,
    ).toBe("UNKNOWN");
    expect(rollupAllergens({ productIds: [], declarations, incomplete: false }).FISH.status).toBe(
      "UNKNOWN",
    );
  });

  it("finds every product through sub-recipes and notices missing ones", () => {
    const v = (
      id: string,
      ingredients: Array<{ productId?: string; subRecipeId?: string }>,
    ): VersionInput => ({
      id,
      recipeId: id,
      recipeCode: id,
      yieldQuantity: d("1"),
      yieldUom: kg,
      portions: null,
      ingredients: ingredients.map((i, n) => ({
        id: `${id}-${n}`,
        lineNo: n + 1,
        productId: i.productId ?? null,
        subRecipeId: i.subRecipeId ?? null,
        quantity: d("1"),
        uom: kg,
        wasteFraction: d("0"),
      })),
    });
    const sauce = v("sauce", [{ productId: "milk" }, { productId: "flour" }]);
    const dish = v("dish", [{ productId: "egg" }, { subRecipeId: "sauce" }]);
    expect(reachedProducts(dish, { activeVersions: new Map([["sauce", sauce]]) })).toEqual({
      productIds: ["egg", "milk", "flour"],
      incomplete: false,
    });
    expect(reachedProducts(dish, { activeVersions: new Map() }).incomplete).toBe(true);
  });
});

describe("label rounding", () => {
  it("rounds energy, small and large amounts and salt", () => {
    expect(roundForLabel("energyKcal", d("249.5"))).toBe("250");
    expect(roundForLabel("fat", d("9.94"))).toBe("9.9");
    expect(roundForLabel("fat", d("10.5"))).toBe("11");
    expect(roundForLabel("salt", d("0.125"))).toBe("0.13");
    expect(roundForLabel("salt", d("1.25"))).toBe("1.3");
  });
});
