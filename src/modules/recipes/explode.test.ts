import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import type { UnitDef } from "@/modules/catalog/units";
import type { VersionInput } from "./costing";
import { explodeRecipe } from "./explode";

const d = (v: string) => new Decimal(v);
const unit = (code: string, dimension: UnitDef["dimension"], factor: string | null): UnitDef => ({
  id: code,
  code,
  dimension,
  factorToBase: factor,
});
const g = unit("g", "MASS", "1");
const kg = unit("kg", "MASS", "1000");
const ml = unit("ml", "VOLUME", "1");
const l = unit("l", "VOLUME", "1000");
const each = unit("each", "COUNT", "1");
const products = new Map(
  [
    { id: "tomato", base: kg },
    { id: "oil", base: l },
    { id: "egg", base: each },
  ].map((p) => [p.id, { ...p, sku: p.id, conversions: [], costs: {} }]),
);
const ing = (
  id: string,
  quantity: string,
  uom: UnitDef,
  ref: { productId?: string; subRecipeId?: string },
  waste = "0",
) => ({
  id,
  lineNo: 1,
  productId: ref.productId ?? null,
  subRecipeId: ref.subRecipeId ?? null,
  quantity: d(quantity),
  uom,
  wasteFraction: d(waste),
});
// 2 kg sauce from 2.4 kg tomatoes (20 % waste → 3 kg gross) and 100 ml oil.
const sauce: VersionInput = {
  id: "sauce-v",
  recipeId: "sauce",
  recipeCode: "SAUCE",
  yieldQuantity: d("2"),
  yieldUom: kg,
  portions: null,
  ingredients: [
    ing("s1", "2.4", kg, { productId: "tomato" }, "0.2"),
    ing("s2", "100", ml, { productId: "oil" }),
  ],
};
// 4 portions: 500 g sauce, 2 eggs.
const pasta: VersionInput = {
  id: "pasta-v",
  recipeId: "pasta",
  recipeCode: "PASTA",
  yieldQuantity: d("4"),
  yieldUom: each,
  portions: d("4"),
  ingredients: [
    ing("p1", "500", g, { subRecipeId: "sauce" }),
    ing("p2", "2", each, { productId: "egg" }),
  ],
};
const world = { products, activeVersions: new Map([["sauce", sauce]]) };
const plain = (m: Map<string, Decimal>) =>
  Object.fromEntries([...m].map(([k, v]) => [k, v.toFixed()]));

describe("recipe explosion", () => {
  it("turns portions sold into product use through sub-recipes, with waste", () => {
    const r = explodeRecipe(pasta, world, d("10"), true);
    expect(r.problems).toEqual([]);
    // 10 portions = 2.5 batches: 1.25 kg sauce (0.625 batches) → 1.875 kg tomato, 0.0625 l oil; 5 eggs.
    expect(plain(r.usage)).toEqual({ tomato: "1.875", oil: "0.0625", egg: "5" });
  });

  it("sells preparations by their yield unit", () => {
    expect(plain(explodeRecipe(sauce, world, d("1"), false).usage)).toEqual({
      tomato: "1.5",
      oil: "0.05",
    });
  });

  it("reports what it cannot expand instead of guessing", () => {
    const broken: VersionInput = {
      ...pasta,
      portions: null,
    };
    expect(explodeRecipe(broken, world, d("1"), true).problems).toEqual([
      { kind: "NO_PORTIONS", recipeCode: "PASTA" },
    ]);
    const noSub = explodeRecipe(pasta, { products, activeVersions: new Map() }, d("1"), true);
    expect(noSub.problems).toEqual([
      { kind: "NO_ACTIVE_VERSION", recipeCode: "PASTA", subRecipeId: "sauce" },
    ]);
    expect(plain(noSub.usage)).toEqual({ egg: "0.5" });
    const wrongUnit: VersionInput = {
      ...pasta,
      ingredients: [ing("p3", "1", l, { productId: "tomato" })],
    };
    expect(explodeRecipe(wrongUnit, world, d("1"), true).problems[0]).toMatchObject({
      kind: "INCOMPATIBLE_UNITS",
      ingredientId: "p3",
    });
  });
});
