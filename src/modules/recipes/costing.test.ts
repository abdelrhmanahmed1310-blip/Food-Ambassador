import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import type { UnitDef } from "@/modules/catalog/units";
import {
  costVersion,
  createsCycle,
  grossQuantity,
  sourceOrder,
  usesProduct,
  type CostWorld,
  type ProductInfo,
  type VersionInput,
} from "./costing";

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

const product = (id: string, base: UnitDef, costs: ProductInfo["costs"], conversions = []) => ({
  id,
  sku: id.toUpperCase(),
  base,
  conversions,
  costs,
});

const tomato = product("tomato", kg, { AVERAGE: { unitCost: d("20"), ref: "WH" } });
const oil = product("oil", l, { STANDARD: { unitCost: d("80"), ref: "std-1" } });
const saffron = product("saffron", g, {});
const egg = product("egg", each, {
  AVERAGE: { unitCost: d("3"), ref: null },
  LAST_PURCHASE: { unitCost: d("3.5"), ref: "GRN-1" },
});

const ing = (
  id: string,
  quantity: string,
  uom: UnitDef,
  opts: { productId?: string; subRecipeId?: string; waste?: string } = {},
) => ({
  id,
  lineNo: Number(id.replace(/\D/g, "")) || 1,
  productId: opts.productId ?? null,
  subRecipeId: opts.subRecipeId ?? null,
  quantity: d(quantity),
  uom,
  wasteFraction: d(opts.waste ?? "0"),
});

// 2 kg of sauce: 2.5 kg tomatoes (net, 20 % trim), 100 ml oil.
const sauce: VersionInput = {
  id: "sauce-v1",
  recipeId: "sauce",
  recipeCode: "SAUCE",
  yieldQuantity: d("2"),
  yieldUom: kg,
  portions: null,
  ingredients: [
    ing("s1", "2.4", kg, { productId: "tomato", waste: "0.2" }),
    ing("s2", "100", ml, { productId: "oil" }),
  ],
};

const world = (extra: Partial<CostWorld> = {}): CostWorld => ({
  products: new Map([tomato, oil, saffron, egg].map((p) => [p.id, p])),
  activeVersions: new Map([["sauce", sauce]]),
  ...extra,
});

describe("recipe costing", () => {
  it("turns net quantities into gross with waste", () => {
    expect(grossQuantity(d("2.4"), d("0.2")).toFixed()).toBe("3");
    expect(grossQuantity(d("1"), d("0")).toFixed()).toBe("1");
    expect(grossQuantity(d("1"), d("0.333333")).toFixed()).toBe("1.499999");
    expect(() => grossQuantity(d("1"), d("1"))).toThrow(RangeError);
  });

  it("tries the chosen source first, then the others", () => {
    expect(sourceOrder("STANDARD")).toEqual(["STANDARD", "AVERAGE", "LAST_PURCHASE"]);
    expect(sourceOrder("AVERAGE")).toEqual(["AVERAGE", "LAST_PURCHASE", "STANDARD"]);
  });

  it("costs products by converted gross quantity and records the source", () => {
    const c = costVersion(sauce, world(), "AVERAGE");
    expect(c.lines[0]).toMatchObject({
      grossQuantity: "3",
      costedQuantity: "3",
      unitCost: "20",
      source: "AVERAGE",
      sourceRef: "WH",
      cost: "60",
    });
    // Oil has only a standard cost: used as the fallback, labelled as such.
    expect(c.lines[1]).toMatchObject({ costedQuantity: "0.1", source: "STANDARD", cost: "8" });
    expect(c).toMatchObject({ totalCost: "68", costPerYieldUnit: "34", missingCount: 0 });
    expect(c.costPerPortion).toBeNull();
  });

  it("costs sub-recipes per yield unit and portions a dish", () => {
    const pasta: VersionInput = {
      id: "pasta-v2",
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
    const c = costVersion(pasta, world(), "LAST_PURCHASE");
    expect(c.lines[0]).toMatchObject({
      costedQuantity: "0.5",
      costedUnit: "kg",
      unitCost: "34",
      source: "SUB_RECIPE",
      cost: "17",
    });
    expect(c.lines[0].sub?.totalCost).toBe("68");
    expect(c.lines[1]).toMatchObject({ source: "LAST_PURCHASE", cost: "7" });
    expect(c).toMatchObject({ totalCost: "24", costPerPortion: "6", costPerYieldUnit: "6" });
  });

  it("reports missing costs and never fills them in", () => {
    const v: VersionInput = {
      ...sauce,
      id: "x",
      recipeId: "x",
      ingredients: [
        ing("x1", "1", g, { productId: "saffron" }),
        ing("x2", "1", l, { productId: "tomato" }),
        ing("x3", "1", kg, { subRecipeId: "missing" }),
        ing("x4", "1", l, { subRecipeId: "sauce" }),
        ing("x5", "1", kg, { productId: "tomato" }),
      ],
    };
    const c = costVersion(v, world(), "AVERAGE");
    expect(c.lines.map((x) => x.missing)).toEqual([
      "NO_COST",
      "INCOMPATIBLE_UNITS",
      "NO_ACTIVE_VERSION",
      "INCOMPATIBLE_UNITS",
      null,
    ]);
    expect(c.missingCount).toBe(4);
    expect(c.totalCost).toBe("20");
  });

  it("counts missing costs inside sub-recipes and stops at cycles", () => {
    const base: VersionInput = {
      id: "base-v1",
      recipeId: "base",
      recipeCode: "BASE",
      yieldQuantity: d("1"),
      yieldUom: kg,
      portions: null,
      ingredients: [
        ing("b1", "1", g, { productId: "saffron" }),
        ing("b2", "1", kg, { subRecipeId: "top" }),
      ],
    };
    const top: VersionInput = {
      ...base,
      id: "top-v1",
      recipeId: "top",
      recipeCode: "TOP",
      ingredients: [ing("t1", "1", kg, { subRecipeId: "base" })],
    };
    const w = world({
      activeVersions: new Map([
        ["base", base],
        ["top", top],
      ]),
    });
    const c = costVersion(top, w, "AVERAGE");
    expect(c.missingCount).toBe(2);
    expect(c.lines[0].sub?.lines.map((x) => x.missing)).toEqual(["NO_COST", "CYCLE"]);
  });

  it("detects cycles through the recipes' sub-recipes", () => {
    const uses = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", []],
    ]);
    expect(createsCycle("c", "a", uses)).toBe(true);
    expect(createsCycle("a", "c", uses)).toBe(false);
    expect(createsCycle("a", "a", uses)).toBe(true);
  });

  it("applies what-if costs over every source and finds products in sub-recipes", () => {
    const pasta: VersionInput = {
      id: "pasta",
      recipeId: "pasta",
      recipeCode: "PASTA",
      yieldQuantity: d("1"),
      yieldUom: each,
      portions: d("1"),
      ingredients: [ing("p1", "1", kg, { subRecipeId: "sauce" })],
    };
    const c = costVersion(pasta, world({ overrides: new Map([["tomato", d("30")]]) }), "AVERAGE");
    // Sauce: 3 kg × 30 + 8 = 98 for 2 kg → 49 per kg.
    expect(c.lines[0].sub?.lines[0]).toMatchObject({ source: "SIMULATED", cost: "90" });
    expect(c.totalCost).toBe("49");
    expect(usesProduct(c, "tomato")).toBe(true);
    expect(usesProduct(c, "egg")).toBe(false);
  });
});
