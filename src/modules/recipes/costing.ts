import { Decimal, roundMoney, roundQuantity, roundUnitCost } from "@/lib/decimal";
import { conversionFactor, type ProductConversion, type UnitDef } from "@/modules/catalog/units";

/**
 * Recipe costing (DECISIONS.md ADR-031). Pure: the service loads every
 * reachable version and product cost first, then this computes the cost of
 * a version line by line. Missing costs are reported, never filled in.
 */

export const COST_POLICIES = ["AVERAGE", "LAST_PURCHASE", "STANDARD"] as const;
export type CostPolicy = (typeof COST_POLICIES)[number];

export interface CostOption {
  /** Per product base unit. */
  unitCost: Decimal;
  /** Where it came from (warehouse, receipt or standard cost record), for the breakdown. */
  ref: string | null;
}

export interface ProductInfo {
  id: string;
  sku: string;
  base: UnitDef;
  conversions: readonly ProductConversion[];
  costs: Partial<Record<CostPolicy, CostOption>>;
}

export interface IngredientInput {
  id: string;
  lineNo: number;
  productId: string | null;
  subRecipeId: string | null;
  /** Net quantity in `uom`. */
  quantity: Decimal;
  uom: UnitDef;
  wasteFraction: Decimal;
}

export interface VersionInput {
  id: string;
  recipeId: string;
  recipeCode: string;
  yieldQuantity: Decimal;
  yieldUom: UnitDef;
  portions: Decimal | null;
  ingredients: readonly IngredientInput[];
}

export interface CostWorld {
  products: ReadonlyMap<string, ProductInfo>;
  /** Active version of each PREPARATION that may be used as a sub-recipe. */
  activeVersions: ReadonlyMap<string, VersionInput>;
}

export type MissingReason = "NO_COST" | "INCOMPATIBLE_UNITS" | "NO_ACTIVE_VERSION" | "CYCLE";

export interface LineCost {
  ingredientId: string;
  lineNo: number;
  productId: string | null;
  subRecipeId: string | null;
  quantity: string;
  uom: string;
  wasteFraction: string;
  /** Net ÷ (1 − waste), in `uom`. */
  grossQuantity: string;
  /** Gross in the product's base unit or the sub-recipe's yield unit. */
  costedQuantity: string | null;
  costedUnit: string | null;
  unitCost: string | null;
  source: CostPolicy | "SUB_RECIPE" | null;
  sourceRef: string | null;
  cost: string | null;
  missing: MissingReason | null;
  sub?: VersionCost;
}

export interface VersionCost {
  versionId: string;
  recipeCode: string;
  totalCost: string;
  costPerYieldUnit: string;
  yieldUnit: string;
  costPerPortion: string | null;
  /** Ingredient lines (including inside sub-recipes) without a cost; totals exclude them. */
  missingCount: number;
  lines: LineCost[];
}

/** Sources tried in order: the chosen one, then the others in a fixed order. */
export function sourceOrder(policy: CostPolicy): CostPolicy[] {
  return [policy, ...COST_POLICIES.filter((p) => p !== policy)];
}

export function grossQuantity(net: Decimal, wasteFraction: Decimal): Decimal {
  if (wasteFraction.lt(0) || !wasteFraction.lt(1)) throw new RangeError("Waste must be in [0, 1)");
  return roundQuantity(net.dividedBy(new Decimal(1).minus(wasteFraction)));
}

function convert(
  quantity: Decimal,
  from: UnitDef,
  to: UnitDef,
  conv: readonly ProductConversion[],
) {
  try {
    return roundQuantity(quantity.times(conversionFactor(from, to, conv)));
  } catch {
    return null;
  }
}

export function costVersion(
  version: VersionInput,
  world: CostWorld,
  policy: CostPolicy,
  stack: readonly string[] = [],
): VersionCost {
  const path = [...stack, version.recipeId];
  let total = new Decimal(0);
  let missingCount = 0;
  const lines: LineCost[] = [];
  for (const ing of version.ingredients) {
    const gross = grossQuantity(ing.quantity, ing.wasteFraction);
    const base: LineCost = {
      ingredientId: ing.id,
      lineNo: ing.lineNo,
      productId: ing.productId,
      subRecipeId: ing.subRecipeId,
      quantity: ing.quantity.toFixed(),
      uom: ing.uom.code,
      wasteFraction: ing.wasteFraction.toFixed(),
      grossQuantity: gross.toFixed(),
      costedQuantity: null,
      costedUnit: null,
      unitCost: null,
      source: null,
      sourceRef: null,
      cost: null,
      missing: null,
    };
    const miss = (reason: MissingReason, extra: Partial<LineCost> = {}) => {
      missingCount += 1;
      lines.push({ ...base, ...extra, missing: reason });
    };
    if (ing.productId) {
      const product = world.products.get(ing.productId);
      if (!product) throw new Error(`Product ${ing.productId} was not loaded`);
      const qty = convert(gross, ing.uom, product.base, product.conversions);
      if (qty === null) {
        miss("INCOMPATIBLE_UNITS");
        continue;
      }
      const at = { costedQuantity: qty.toFixed(), costedUnit: product.base.code };
      const found = sourceOrder(policy)
        .map((p) => [p, product.costs[p]] as const)
        .find(([, c]) => c !== undefined);
      if (!found) {
        miss("NO_COST", at);
        continue;
      }
      const [source, option] = found as [CostPolicy, CostOption];
      const cost = roundMoney(qty.times(option.unitCost));
      total = total.plus(cost);
      lines.push({
        ...base,
        ...at,
        unitCost: option.unitCost.toFixed(),
        source,
        sourceRef: option.ref,
        cost: cost.toFixed(),
      });
      continue;
    }
    const subId = ing.subRecipeId as string;
    if (path.includes(subId)) {
      miss("CYCLE");
      continue;
    }
    const subVersion = world.activeVersions.get(subId);
    if (!subVersion) {
      miss("NO_ACTIVE_VERSION");
      continue;
    }
    const qty = convert(gross, ing.uom, subVersion.yieldUom, []);
    if (qty === null) {
      miss("INCOMPATIBLE_UNITS");
      continue;
    }
    const sub = costVersion(subVersion, world, policy, path);
    missingCount += sub.missingCount;
    const cost = roundMoney(qty.times(new Decimal(sub.costPerYieldUnit)));
    total = total.plus(cost);
    lines.push({
      ...base,
      costedQuantity: qty.toFixed(),
      costedUnit: subVersion.yieldUom.code,
      unitCost: sub.costPerYieldUnit,
      source: "SUB_RECIPE",
      sourceRef: subVersion.id,
      cost: cost.toFixed(),
      sub,
    });
  }
  return {
    versionId: version.id,
    recipeCode: version.recipeCode,
    totalCost: total.toFixed(),
    costPerYieldUnit: roundUnitCost(total.dividedBy(version.yieldQuantity)).toFixed(),
    yieldUnit: version.yieldUom.code,
    costPerPortion: version.portions
      ? roundMoney(total.dividedBy(version.portions)).toFixed()
      : null,
    missingCount,
    lines,
  };
}

/**
 * Would using `subRecipeId` inside `recipeId` make a recipe contain itself?
 * `uses` maps a recipe to the sub-recipes of the version that counts for it
 * (its active version, or the draft being checked).
 */
export function createsCycle(
  recipeId: string,
  subRecipeId: string,
  uses: ReadonlyMap<string, readonly string[]>,
): boolean {
  const seen = new Set<string>();
  const stack = [subRecipeId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === recipeId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(uses.get(current) ?? []));
  }
  return false;
}
