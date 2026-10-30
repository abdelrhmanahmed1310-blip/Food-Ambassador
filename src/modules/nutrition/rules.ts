import { Decimal, toDecimal } from "@/lib/decimal";
import type { ProductConversion, UnitDef } from "@/modules/catalog/units";
import type { CostWorld, VersionInput } from "@/modules/recipes/costing";
import { ALLERGEN_CODES, type AllergenCode } from "./allergens";

/**
 * Pure nutrition and allergen rules (DECISIONS.md ADR-040). Nothing is
 * inferred: a value that is not known for every ingredient is not known for
 * the recipe, and "free from" needs a verified statement for every
 * ingredient.
 */

export const NUTRIENTS = [
  "energyKcal",
  "energyKj",
  "fat",
  "saturatedFat",
  "carbohydrate",
  "sugars",
  "fibre",
  "protein",
  "salt",
  "sodium",
] as const;
export type Nutrient = (typeof NUTRIENTS)[number];

/** Needed before a label can be generated. */
export const LABEL_NUTRIENTS: readonly Nutrient[] = [
  "energyKcal",
  "fat",
  "saturatedFat",
  "carbohydrate",
  "sugars",
  "protein",
  "salt",
];

export type Basis = "PER_100G" | "PER_100ML";

export interface ProfileInput {
  id: string;
  basis: Basis;
  verified: boolean;
  values: Partial<Record<Nutrient, Decimal | null>>;
}

export interface NutritionProduct {
  id: string;
  base: UnitDef;
  conversions: readonly ProductConversion[];
}

/**
 * Grams (PER_100G) or millilitres (PER_100ML) in one base unit of the
 * product: from the base unit itself, else from a product conversion to a
 * fixed-size unit of that dimension (e.g. "1 each = 0.25 kg"). Null when no
 * such conversion exists — never guessed.
 */
export function basisAmountPerBaseUnit(
  product: NutritionProduct,
  basis: Basis,
  units: ReadonlyMap<string, UnitDef>,
): Decimal | null {
  const dimension = basis === "PER_100G" ? "MASS" : "VOLUME";
  if (product.base.dimension === dimension && product.base.factorToBase !== null)
    return toDecimal(product.base.factorToBase);
  for (const c of product.conversions) {
    const u = units.get(c.uomId);
    if (u && u.dimension === dimension && u.factorToBase !== null)
      return toDecimal(u.factorToBase).dividedBy(toDecimal(c.factorToBase));
  }
  return null;
}

export interface NutritionRollup {
  /** Per batch; null = not known (see `missing`). */
  totals: Record<Nutrient, Decimal | null>;
  /** Products lacking a value, per nutrient. */
  missing: Record<Nutrient, string[]>;
  noProfile: string[];
  noConversion: string[];
  /** Products whose profile is not verified (values still counted). */
  unverified: string[];
  /** Edible grams of each product with a known mass, for the ingredient list order. */
  grams: Map<string, Decimal>;
}

/**
 * Sum nutrients over the products a batch uses (`usage`: net quantity in
 * each product's base unit). If the recipe could not be expanded fully
 * (`incomplete`), nothing is known.
 */
export function rollupNutrition(input: {
  usage: ReadonlyMap<string, Decimal>;
  products: ReadonlyMap<string, NutritionProduct>;
  profiles: ReadonlyMap<string, ProfileInput>;
  units: ReadonlyMap<string, UnitDef>;
  incomplete: boolean;
}): NutritionRollup {
  const totals = Object.fromEntries(NUTRIENTS.map((n) => [n, new Decimal(0)])) as Record<
    Nutrient,
    Decimal | null
  >;
  const missing = Object.fromEntries(NUTRIENTS.map((n) => [n, [] as string[]])) as Record<
    Nutrient,
    string[]
  >;
  const noProfile: string[] = [];
  const noConversion: string[] = [];
  const unverified: string[] = [];
  const grams = new Map<string, Decimal>();
  for (const [productId, quantity] of input.usage) {
    const product = input.products.get(productId);
    if (!product) throw new Error(`Product ${productId} was not loaded`);
    const perGram = basisAmountPerBaseUnit(product, "PER_100G", input.units);
    if (perGram) grams.set(productId, quantity.times(perGram));
    const profile = input.profiles.get(productId);
    if (!profile) {
      noProfile.push(productId);
      for (const n of NUTRIENTS) missing[n].push(productId);
      continue;
    }
    const per = basisAmountPerBaseUnit(product, profile.basis, input.units);
    if (!per) {
      noConversion.push(productId);
      for (const n of NUTRIENTS) missing[n].push(productId);
      continue;
    }
    if (!profile.verified) unverified.push(productId);
    const hundreds = quantity.times(per).dividedBy(100);
    for (const n of NUTRIENTS) {
      const v = profile.values[n];
      if (v === null || v === undefined) missing[n].push(productId);
      else if (totals[n] !== null) totals[n] = (totals[n] as Decimal).plus(hundreds.times(v));
    }
  }
  for (const n of NUTRIENTS) if (input.incomplete || missing[n].length > 0) totals[n] = null;
  return { totals, missing, noProfile, noConversion, unverified, grams };
}

export type DeclarationInput = {
  status: "CONTAINS" | "MAY_CONTAIN" | "FREE_FROM" | "UNKNOWN";
  verified: boolean;
};

export interface AllergenResult {
  status: "CONTAINS" | "MAY_CONTAIN" | "FREE_FROM" | "UNKNOWN";
  contains: string[];
  mayContain: string[];
  /** Products with no statement, UNKNOWN, or an unverified "free from". */
  unknown: string[];
}

/**
 * Per allergen over every product a recipe reaches: any CONTAINS → contains;
 * else any MAY_CONTAIN → may contain; else FREE_FROM only if every product
 * has a verified FREE_FROM and the recipe was expanded fully; else unknown.
 */
export function rollupAllergens(input: {
  productIds: readonly string[];
  declarations: ReadonlyMap<string, ReadonlyMap<AllergenCode, DeclarationInput>>;
  incomplete: boolean;
}): Record<AllergenCode, AllergenResult> {
  const result = {} as Record<AllergenCode, AllergenResult>;
  for (const code of ALLERGEN_CODES) {
    const r: AllergenResult = { status: "UNKNOWN", contains: [], mayContain: [], unknown: [] };
    for (const id of input.productIds) {
      const d = input.declarations.get(id)?.get(code);
      if (d?.status === "CONTAINS") r.contains.push(id);
      else if (d?.status === "MAY_CONTAIN") r.mayContain.push(id);
      else if (!(d?.status === "FREE_FROM" && d.verified)) r.unknown.push(id);
    }
    if (r.contains.length > 0) r.status = "CONTAINS";
    else if (r.mayContain.length > 0) r.status = "MAY_CONTAIN";
    else if (r.unknown.length === 0 && input.productIds.length > 0 && !input.incomplete)
      r.status = "FREE_FROM";
    result[code] = r;
  }
  return result;
}

/** Every product a version reaches through active sub-recipes, whatever the units. */
export function reachedProducts(
  root: VersionInput,
  world: Pick<CostWorld, "activeVersions">,
): { productIds: string[]; incomplete: boolean } {
  const ids = new Set<string>();
  let incomplete = false;
  const walk = (v: VersionInput, path: readonly string[]) => {
    for (const ing of v.ingredients) {
      if (ing.productId) {
        ids.add(ing.productId);
        continue;
      }
      const subId = ing.subRecipeId as string;
      const sub = world.activeVersions.get(subId);
      if (!sub || path.includes(subId)) {
        incomplete = true;
        continue;
      }
      walk(sub, [...path, subId]);
    }
  };
  walk(root, [root.recipeId]);
  return { productIds: [...ids], incomplete };
}

/**
 * Rounding for display on a label (after the EU guidance on tolerances,
 * 2012): energy to whole kcal/kJ; salt and sodium to 2 decimals below 1 g,
 * else 1; other nutrients to 1 decimal below 10 g, else whole grams.
 */
export function roundForLabel(nutrient: Nutrient, value: Decimal): string {
  if (nutrient === "energyKcal" || nutrient === "energyKj")
    return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
  if (nutrient === "salt" || nutrient === "sodium")
    return value.lt(1)
      ? value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : value.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1);
  return value.lt(10)
    ? value.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1)
    : value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}
