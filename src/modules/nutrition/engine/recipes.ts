import "server-only";
import { Decimal, toDecimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { basisAmountPerBaseUnit, NUTRIENTS, type Nutrient } from "../rules";
import { recipeNutrition } from "../service";
import { aggregate, basisQuantity, CalcError, type IngredientIn, type ValueIn } from "./calculate";

/**
 * Full nutrient panel of a recipe (DECISIONS.md ADR-132): each ingredient
 * product's linked library food, scaled by the edible amount the recipe
 * uses. The product's own verified nutrition profile (manufacturer
 * specification, laboratory analysis) wins for the nutrients it gives —
 * generic database values never replace it. An ingredient with neither
 * makes every total incomplete; nothing unknown is counted as zero.
 */

/** Summary profile columns by dictionary code (sodium is kept in g on profiles, mg in the dictionary). */
const PROFILE_CODES: Record<Nutrient, { code: string; factor: string }> = {
  energyKcal: { code: "energy_kcal", factor: "1" },
  energyKj: { code: "energy_kj", factor: "1" },
  fat: { code: "fat", factor: "1" },
  saturatedFat: { code: "saturated_fat", factor: "1" },
  carbohydrate: { code: "carbohydrate", factor: "1" },
  sugars: { code: "sugars", factor: "1" },
  fibre: { code: "fibre", factor: "1" },
  protein: { code: "protein", factor: "1" },
  salt: { code: "salt", factor: "1" },
  sodium: { code: "sodium", factor: "1000" },
};

export type IngredientCoverage =
  "PROFILE" | "LIBRARY" | "PROFILE_AND_LIBRARY" | "NO_DATA" | "NO_WEIGHT" | "NEEDS_DENSITY";

export async function recipeFullNutrition(ctx: TenantContext, recipeId: string) {
  assertPermission(ctx.grants, "nutrition.view");
  const base = await recipeNutrition(ctx, recipeId);
  if (!base.calc) return { recipe: base.recipe, active: null, panel: null };
  const calc = base.calc;
  const productIds = [...calc.exploded.usage.keys()];
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [foods, profiles, dictionary] = await Promise.all([
      tx.referenceFood.findMany({
        where: {
          organizationId: ctx.organizationId,
          linkedProductId: { in: productIds },
          archivedAt: null,
        },
        orderBy: [{ verifiedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
        select: {
          id: true,
          name: true,
          nameAr: true,
          source: true,
          sourceId: true,
          basis: true,
          verifiedAt: true,
          linkedProductId: true,
          nutrientValues: {
            select: {
              amount: true,
              unit: true,
              status: true,
              nutrient: { select: { code: true } },
            },
          },
          portions: { select: { id: true, gramWeight: true, millilitres: true } },
        },
      }),
      tx.nutritionProfile.findMany({
        where: {
          organizationId: ctx.organizationId,
          productId: { in: productIds },
          supersededAt: null,
          verifiedAt: { not: null },
        },
      }),
      tx.nutrient.findMany({
        where: { code: { not: null } },
        select: {
          code: true,
          name: true,
          nameAr: true,
          unit: true,
          group: true,
          rank: true,
          isCore: true,
        },
        orderBy: [{ rank: "asc" }, { name: "asc" }],
      }),
    ]);
    // One food per product: the verified, most recently updated one.
    const foodOf = new Map<string, (typeof foods)[number]>();
    for (const f of foods)
      if (f.linkedProductId && !foodOf.has(f.linkedProductId)) foodOf.set(f.linkedProductId, f);
    const profileOf = new Map(profiles.map((p) => [p.productId, p]));

    const ingredients: IngredientIn[] = [];
    const rows: Array<{
      productId: string;
      grams: string | null;
      coverage: IngredientCoverage;
      food: {
        id: string;
        name: string;
        nameAr: string | null;
        source: string;
        verified: boolean;
      } | null;
    }> = [];
    for (const [productId, quantity] of calc.exploded.usage) {
      const product = calc.world.products.get(productId)!;
      const grams = calc.nutrition.grams.get(productId) ?? null;
      const food = foodOf.get(productId) ?? null;
      const profile = profileOf.get(productId) ?? null;
      const values = new Map<string, ValueIn>();
      const covered = new Set<string>();
      let coverage: IngredientCoverage = "NO_DATA";

      // 1. The product's verified profile, for the nutrients it gives.
      if (profile) {
        const per = basisAmountPerBaseUnit(product, profile.basis, base.units);
        if (per) {
          const hundreds = quantity.times(per).dividedBy(100);
          for (const n of NUTRIENTS) {
            const v = profile[n];
            if (v === null) continue;
            const { code, factor } = PROFILE_CODES[n];
            values.set(code, {
              code,
              unit:
                n === "energyKcal" ? "kcal" : n === "energyKj" ? "kJ" : n === "sodium" ? "mg" : "g",
              amount: toDecimal(v).times(factor).times(hundreds).toFixed(),
              status: "REPORTED",
            });
            covered.add(code);
          }
          coverage = "PROFILE";
        }
      }

      // 2. The linked library food for everything else.
      let foodProblem: IngredientCoverage | null = null;
      if (food) {
        // Hundreds of grams (or millilitres) of the food that the recipe uses.
        let hundreds: Decimal | null = null;
        const basis = (food.basis ?? "PER_100G") as "PER_100G" | "PER_100ML";
        const perBase = basisAmountPerBaseUnit(product, basis, base.units);
        if (perBase) hundreds = quantity.times(perBase).dividedBy(100);
        else if (grams) {
          try {
            hundreds = basisQuantity(
              {
                basis,
                portions: food.portions.map((p) => ({
                  id: p.id,
                  gramWeight: p.gramWeight?.toString() ?? null,
                  millilitres: p.millilitres?.toString() ?? null,
                })),
              },
              grams.toFixed(),
              "g",
            ).basis.dividedBy(100);
          } catch (error) {
            if (!(error instanceof CalcError)) throw error;
            foodProblem = "NEEDS_DENSITY";
          }
        } else foodProblem = "NO_WEIGHT";
        if (hundreds) {
          for (const v of food.nutrientValues) {
            const code = v.nutrient.code;
            if (!code || covered.has(code)) continue;
            values.set(code, {
              code,
              unit: v.unit,
              amount: v.amount === null ? null : toDecimal(v.amount).times(hundreds).toFixed(),
              status: v.status,
            });
          }
          coverage = coverage === "PROFILE" ? "PROFILE_AND_LIBRARY" : "LIBRARY";
        }
      }
      if (coverage === "NO_DATA" && foodProblem) coverage = foodProblem;
      // Already scaled to the amount the recipe uses; aggregate() multiplies by basisQty / 100.
      ingredients.push({
        ref: productId,
        label: productId,
        values: [...values.values()],
        basisQty: new Decimal(100),
        grams,
      });
      rows.push({
        productId,
        grams: grams?.toDecimalPlaces(2).toFixed() ?? null,
        coverage,
        food: food
          ? {
              id: food.id,
              name: food.name,
              nameAr: food.nameAr,
              source: food.source,
              verified: !!food.verifiedAt,
            }
          : null,
      });
    }

    const present = new Set(ingredients.flatMap((i) => i.values.map((v) => v.code)));
    const codes = dictionary
      .filter((d) => d.isCore || present.has(d.code!))
      .map((d) => ({ code: d.code!, unit: d.unit }));
    const meta = new Map(dictionary.map((d) => [d.code!, d]));
    // A recipe with unresolved parts (no active sub-recipe, unit problems) claims no totals.
    const total = aggregate(ingredients, codes).map((r) =>
      calc.incomplete ? { ...r, amount: null, complete: false } : r,
    );
    const root = calc.root;
    const finishedGrams =
      root.yieldUom.dimension === "MASS" && root.yieldUom.factorToBase !== null
        ? root.yieldQuantity.times(toDecimal(root.yieldUom.factorToBase))
        : null;
    const divide = (by: Decimal | null) =>
      by && by.gt(0)
        ? total.map((r) => ({
            ...r,
            amount:
              r.amount === null
                ? null
                : new Decimal(r.amount).dividedBy(by).toDecimalPlaces(4).toFixed(),
            knownAmount: new Decimal(r.knownAmount).dividedBy(by).toDecimalPlaces(4).toFixed(),
          }))
        : null;
    const withMeta = (list: typeof total | null) =>
      list?.map((r) => ({
        ...r,
        name: meta.get(r.code)?.name ?? r.code,
        nameAr: meta.get(r.code)?.nameAr ?? null,
        group: meta.get(r.code)?.group ?? "OTHER",
        isCore: meta.get(r.code)?.isCore ?? false,
      })) ?? null;
    return {
      recipe: base.recipe,
      active: base.active,
      panel: {
        incomplete: calc.incomplete,
        ingredients: rows,
        names: base.names,
        total: withMeta(total)!,
        perPortion: withMeta(divide(root.portions ?? null)),
        per100g: withMeta(divide(finishedGrams ? finishedGrams.dividedBy(100) : null)),
        finishedGrams: finishedGrams?.toFixed() ?? null,
        portions: root.portions?.toFixed() ?? null,
      },
    };
  });
}
