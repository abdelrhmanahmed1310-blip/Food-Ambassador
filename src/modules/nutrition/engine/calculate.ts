import { Decimal } from "@/lib/decimal";

/**
 * Nutrition calculations (DECISIONS.md ADR-132). Pure and Decimal-only.
 *
 * Nutrient per serving = nutrient per 100 × serving quantity ÷ 100, on the
 * food's own basis (100 g, or 100 ml for foods published per 100 ml). Mass
 * converts to volume only with the food's own density from a portion that
 * gives both its weight and its volume; millilitres are never taken as grams.
 * A missing value stays missing: totals say which ingredients lack it.
 */

export const KCAL_TO_KJ = new Decimal("4.184");
/** Salt (g) = sodium (mg) × 2.5 ÷ 1000. */
export const saltFromSodiumMg = (sodiumMg: Decimal) => sodiumMg.times("2.5").dividedBy(1000);
export const kjFromKcal = (kcal: Decimal) => kcal.times(KCAL_TO_KJ);

export type Basis = "PER_100G" | "PER_100ML";
export type QuantityUnit = "g" | "kg" | "mg" | "oz" | "lb" | "ml" | "l" | "portion";

const MASS_G: Record<string, Decimal> = {
  g: new Decimal(1),
  kg: new Decimal(1000),
  mg: new Decimal("0.001"),
  oz: new Decimal("28.349523125"),
  lb: new Decimal("453.59237"),
};
const VOLUME_ML: Record<string, Decimal> = { ml: new Decimal(1), l: new Decimal(1000) };

export interface FoodForCalc {
  basis: Basis;
  portions: ReadonlyArray<{ id: string; gramWeight: string | null; millilitres: string | null }>;
}

export class CalcError extends Error {
  constructor(
    readonly code:
      "NEEDS_DENSITY" | "UNKNOWN_PORTION" | "PORTION_WITHOUT_WEIGHT" | "INVALID_QUANTITY",
    message: string,
  ) {
    super(message);
  }
}

/** g per ml from a portion with both weight and volume, if the food has one. */
export function densityOf(food: FoodForCalc): Decimal | null {
  const p = food.portions.find((x) => x.gramWeight && x.millilitres);
  return p ? new Decimal(p.gramWeight!).dividedBy(p.millilitres!) : null;
}

/**
 * A quantity of a food in its basis unit (g for per-100 g foods, ml for
 * per-100 ml foods), plus its weight in grams when that is known.
 */
export function basisQuantity(
  food: FoodForCalc,
  quantity: string,
  unit: QuantityUnit,
  portionId?: string,
): { basis: Decimal; grams: Decimal | null } {
  if (!/^\d+(\.\d+)?$/.test(quantity) || new Decimal(quantity).lte(0))
    throw new CalcError("INVALID_QUANTITY", "Quantity must be a positive number");
  const q = new Decimal(quantity);
  const density = densityOf(food);
  let grams: Decimal | null = null;
  let ml: Decimal | null = null;
  if (unit === "portion") {
    const p = food.portions.find((x) => x.id === portionId);
    if (!p) throw new CalcError("UNKNOWN_PORTION", "This portion does not belong to the food");
    if (p.gramWeight) grams = q.times(p.gramWeight);
    if (p.millilitres) ml = q.times(p.millilitres);
    if (!grams && !ml)
      throw new CalcError("PORTION_WITHOUT_WEIGHT", "This portion has no weight or volume");
  } else if (MASS_G[unit]) grams = q.times(MASS_G[unit]);
  else ml = q.times(VOLUME_ML[unit]);
  if (food.basis === "PER_100G") {
    if (!grams) {
      if (!density)
        throw new CalcError(
          "NEEDS_DENSITY",
          "A volume needs the food's density (a portion with weight and volume)",
        );
      grams = (ml as Decimal).times(density);
    }
    return { basis: grams, grams };
  }
  if (!ml) {
    if (!density)
      throw new CalcError(
        "NEEDS_DENSITY",
        "A weight needs the food's density (a portion with weight and volume)",
      );
    ml = (grams as Decimal).dividedBy(density);
  }
  return { basis: ml, grams: grams ?? (density ? ml.times(density) : null) };
}

export interface ValueIn {
  code: string;
  unit: string;
  /** Per 100 g or 100 ml of the food; null = below detection or not convertible. */
  amount: string | null;
  status: "REPORTED" | "CALCULATED" | "BELOW_DETECTION" | "NOT_APPLICABLE";
}

export interface ValueOut {
  code: string;
  unit: string;
  amount: string | null;
  status: ValueIn["status"] | "MISSING";
}

const fix = (d: Decimal) => d.toDecimalPlaces(4).toFixed();

/** Values per 100 scaled to a quantity in the basis unit. Missing and below-detection stay without a figure. */
export function scale(values: readonly ValueIn[], basisQty: Decimal): ValueOut[] {
  const f = basisQty.dividedBy(100);
  return values.map((v) => ({
    code: v.code,
    unit: v.unit,
    status: v.status,
    amount:
      v.status === "NOT_APPLICABLE"
        ? null
        : v.amount === null
          ? null
          : fix(new Decimal(v.amount).times(f)),
  }));
}

export interface IngredientIn {
  ref: string;
  label: string;
  values: readonly ValueIn[];
  basisQty: Decimal;
  grams: Decimal | null;
}

export interface TotalOut {
  code: string;
  unit: string;
  /** Null unless every ingredient has the nutrient. */
  amount: string | null;
  /** The sum over the ingredients that have it. */
  knownAmount: string;
  complete: boolean;
  missingIn: string[];
  belowDetectionIn: string[];
}

/**
 * A recipe's totals: per nutrient over every ingredient. An ingredient
 * without the nutrient leaves the total unknown (listed); not applicable
 * counts as none; below detection is listed and not added.
 */
export function aggregate(
  ingredients: readonly IngredientIn[],
  codes: ReadonlyArray<{ code: string; unit: string }>,
): TotalOut[] {
  return codes.map(({ code, unit }) => {
    let known = new Decimal(0);
    const missingIn: string[] = [];
    const belowDetectionIn: string[] = [];
    for (const ing of ingredients) {
      const v = ing.values.find((x) => x.code === code);
      if (!v) {
        missingIn.push(ing.label);
        continue;
      }
      if (v.status === "NOT_APPLICABLE") continue;
      if (v.status === "BELOW_DETECTION") {
        belowDetectionIn.push(ing.label);
        continue;
      }
      if (v.amount === null || v.unit !== unit) {
        missingIn.push(ing.label);
        continue;
      }
      known = known.plus(new Decimal(v.amount).times(ing.basisQty).dividedBy(100));
    }
    const complete = missingIn.length === 0 && belowDetectionIn.length === 0;
    return {
      code,
      unit,
      amount: complete ? fix(known) : null,
      knownAmount: fix(known),
      complete,
      missingIn,
      belowDetectionIn,
    };
  });
}

export interface RecipeResult {
  totalGrams: string | null;
  finishedGrams: string | null;
  yieldFromRawWeight: boolean;
  servings: number | null;
  total: TotalOut[];
  perServing: TotalOut[] | null;
  per100g: TotalOut[] | null;
}

const divide = (rows: readonly TotalOut[], by: Decimal, times = new Decimal(1)): TotalOut[] =>
  rows.map((r) => ({
    ...r,
    amount: r.amount === null ? null : fix(new Decimal(r.amount).times(times).dividedBy(by)),
    knownAmount: fix(new Decimal(r.knownAmount).times(times).dividedBy(by)),
  }));

/**
 * Totals, per serving and per 100 g of the finished recipe. The finished
 * weight is the given yield (after cooking losses); without one, the raw
 * ingredient weight is used and said so.
 */
export function analyzeRecipe(input: {
  ingredients: readonly IngredientIn[];
  codes: ReadonlyArray<{ code: string; unit: string }>;
  servings?: number | null;
  finishedGrams?: string | null;
}): RecipeResult {
  const total = aggregate(input.ingredients, input.codes);
  const weights = input.ingredients.map((i) => i.grams);
  const totalGrams = weights.every((g) => g !== null)
    ? weights.reduce((a: Decimal, g) => a.plus(g!), new Decimal(0))
    : null;
  const finished = input.finishedGrams ? new Decimal(input.finishedGrams) : totalGrams;
  const servings = input.servings && input.servings > 0 ? input.servings : null;
  return {
    totalGrams: totalGrams ? fix(totalGrams) : null,
    finishedGrams: finished ? fix(finished) : null,
    yieldFromRawWeight: !input.finishedGrams && totalGrams !== null,
    servings,
    total,
    perServing: servings ? divide(total, new Decimal(servings)) : null,
    per100g: finished && finished.gt(0) ? divide(total, finished, new Decimal(100)) : null,
  };
}
