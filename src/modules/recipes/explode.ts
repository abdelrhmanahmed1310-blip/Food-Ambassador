import { Decimal, roundQuantity } from "@/lib/decimal";
import { conversionFactor } from "@/modules/catalog/units";
import { grossQuantity, type CostWorld, type VersionInput } from "./costing";

/**
 * What selling `quantity` of a recipe uses, per product in its base unit
 * (DECISIONS.md ADR-036). Pure. Dishes are sold in portions; preparations in
 * their yield unit. Waste is included (gross quantities); sub-recipes are
 * expanded through their active versions. Problems are reported, never
 * worked around.
 */

export type ExplodeProblem =
  | { kind: "NO_PORTIONS"; recipeCode: string }
  | { kind: "NO_ACTIVE_VERSION"; recipeCode: string; subRecipeId: string }
  | { kind: "INCOMPATIBLE_UNITS"; recipeCode: string; ingredientId: string }
  | { kind: "CYCLE"; recipeCode: string };

export function explodeRecipe(
  version: VersionInput,
  world: Pick<CostWorld, "products" | "activeVersions">,
  quantity: Decimal,
  asPortions: boolean,
): { usage: Map<string, Decimal>; problems: ExplodeProblem[] } {
  const usage = new Map<string, Decimal>();
  const problems: ExplodeProblem[] = [];
  const walk = (v: VersionInput, batches: Decimal, path: readonly string[]) => {
    for (const ing of v.ingredients) {
      const gross = grossQuantity(ing.quantity, ing.wasteFraction).times(batches);
      if (ing.productId) {
        const product = world.products.get(ing.productId);
        if (!product) throw new Error(`Product ${ing.productId} was not loaded`);
        try {
          const base = gross.times(conversionFactor(ing.uom, product.base, product.conversions));
          usage.set(product.id, (usage.get(product.id) ?? new Decimal(0)).plus(base));
        } catch {
          problems.push({
            kind: "INCOMPATIBLE_UNITS",
            recipeCode: v.recipeCode,
            ingredientId: ing.id,
          });
        }
        continue;
      }
      const subId = ing.subRecipeId as string;
      if (path.includes(subId)) {
        problems.push({ kind: "CYCLE", recipeCode: v.recipeCode });
        continue;
      }
      const sub = world.activeVersions.get(subId);
      if (!sub) {
        problems.push({ kind: "NO_ACTIVE_VERSION", recipeCode: v.recipeCode, subRecipeId: subId });
        continue;
      }
      try {
        const inYield = gross.times(conversionFactor(ing.uom, sub.yieldUom, []));
        walk(sub, inYield.dividedBy(sub.yieldQuantity), [...path, subId]);
      } catch {
        problems.push({
          kind: "INCOMPATIBLE_UNITS",
          recipeCode: v.recipeCode,
          ingredientId: ing.id,
        });
      }
    }
  };
  let batches: Decimal | null;
  if (asPortions) batches = version.portions ? quantity.dividedBy(version.portions) : null;
  else batches = quantity.dividedBy(version.yieldQuantity);
  if (batches === null) problems.push({ kind: "NO_PORTIONS", recipeCode: version.recipeCode });
  else walk(version, batches, [version.recipeId]);
  return {
    usage: new Map([...usage].map(([id, q]) => [id, roundQuantity(q)])),
    problems,
  };
}
