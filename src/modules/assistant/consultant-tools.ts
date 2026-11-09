import "server-only";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { ALLERGEN_CODES } from "@/modules/nutrition/allergens";
import { allergenMatrix, recipeNutrition } from "@/modules/nutrition/service";
import { foodCostReport } from "@/modules/recipes/menu";
import { listRecipes } from "@/modules/recipes/recipes";
import type { TenantContext } from "@/modules/tenancy/context";
import { runToolFrom, schema, tool, type ToolResult } from "./tools";

/**
 * What the food consultant can read (DECISIONS.md ADR-131): the
 * organization's recipes, dish costs and prices, and allergens and
 * nutrition as recorded — through the same services as the app's pages,
 * as the asking person, so it sees exactly what they may see. Read only.
 */

const id = z.uuid();
const pct = (f: { toString(): string } | null) =>
  f === null ? null : `${(Number(f.toString()) * 100).toFixed(1)}%`;

export const CONSULTANT_TOOLS = [
  tool({
    definition: {
      name: "find_recipes",
      description:
        "Search the organization's recipes (dishes and preparations) by code or name, in English or Arabic. Returns IDs to pass to the other tools. Leave the query empty to list the first recipes.",
      input_schema: schema({
        query: { type: "string", description: "Part of a code or name; may be empty." },
      }),
      strict: true,
    },
    input: z.object({ query: z.string().max(80).optional() }).strict(),
    async run(ctx, i) {
      const r = await listRecipes(ctx, { q: i.query });
      return {
        data: {
          total: r.total,
          recipes: r.items.map((x) => ({
            id: x.id,
            code: x.code,
            name: x.name,
            nameAr: x.nameAr,
            type: x.type,
            hasActiveVersion: x.versions.some((v) => v.status === "ACTIVE"),
          })),
        },
        sources: [
          {
            label: "Recipes",
            href: `/recipes${i.query ? `?q=${encodeURIComponent(i.query)}` : ""}`,
          },
        ],
      };
    },
  }),
  tool({
    definition: {
      name: "dish_costs",
      description:
        "For every active dish: cost per portion, current selling price, food cost %, margin, target food cost % and status (OK, ABOVE_TARGET, NO_PRICE, NO_TARGET, INCOMPLETE when some ingredients have no cost), with the price that would meet the target. Optionally only one recipe.",
      input_schema: schema({
        recipeId: { type: "string", description: "Optional recipe ID from find_recipes." },
      }),
      strict: true,
    },
    input: z.object({ recipeId: id.optional() }).strict(),
    async run(ctx, i) {
      const r = await foodCostReport(ctx, {});
      const rows = r.rows.filter((x) => !i.recipeId || x.recipe.id === i.recipeId);
      return {
        data: {
          costPolicy: r.policy,
          organizationTarget: pct(r.orgTarget),
          dishes: rows.slice(0, 100).map((x) => ({
            code: x.recipe.code,
            name: x.recipe.name,
            nameAr: x.recipe.nameAr,
            costPerPortion: x.costPerPortion.toFixed(2),
            ingredientsWithoutCost: x.missingCount,
            sellingPriceNet: x.price?.net?.toFixed(2) ?? null,
            foodCost: pct(x.fraction),
            margin: x.margin?.toFixed(2) ?? null,
            target: pct(x.target),
            priceForTarget: x.suggested?.toFixed(2) ?? null,
            status: x.status,
          })),
        },
        sources: [
          i.recipeId
            ? { label: "Recipe", href: `/recipes/${i.recipeId}` }
            : { label: "Food cost", href: "/recipes/food-cost" },
        ],
      };
    },
  }),
  tool({
    definition: {
      name: "recipe_nutrition_allergens",
      description:
        "One recipe's allergens (CONTAINS, MAY_CONTAIN, FREE_FROM only when every ingredient is verified free, otherwise UNKNOWN) and nutrition per portion and per 100 g/ml, computed from the ingredients' recorded profiles, with what is missing or unverified.",
      input_schema: schema(
        { recipeId: { type: "string", description: "Recipe ID from find_recipes." } },
        ["recipeId"],
      ),
      strict: true,
    },
    input: z.object({ recipeId: id }).strict(),
    async run(ctx, i) {
      const r = await recipeNutrition(ctx, i.recipeId);
      const sku = (pid: string) => r.names.get(pid)?.sku ?? pid;
      if (!r.calc)
        return {
          data: { recipe: r.recipe, note: "This recipe has no active version yet." },
          sources: [{ label: r.recipe.code, href: `/recipes/${i.recipeId}` }],
        };
      const c = r.calc;
      const fmt = (v: Record<string, { toFixed(n?: number): string } | null> | null) =>
        v
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x ? x.toFixed(1) : null]))
          : null;
      return {
        data: {
          recipe: { code: r.recipe.code, name: r.recipe.name, nameAr: r.recipe.nameAr },
          version: r.active?.versionNo,
          incompleteRecipe: c.incomplete,
          allergens: Object.fromEntries(
            Object.entries(c.allergens).map(([code, a]) => [
              code,
              {
                status: a.status,
                containsVia: a.contains.map(sku),
                mayContainVia: a.mayContain.map(sku),
                notEstablishedFor: a.unknown.map(sku).slice(0, 10),
              },
            ]),
          ),
          nutritionPerPortion: fmt(c.perPortion),
          nutritionPer100: fmt(c.per100),
          per100Basis: c.per100Basis,
          ingredientsWithoutProfile: c.nutrition.noProfile.map(sku),
          ingredientsWithUnverifiedProfile: c.nutrition.unverified.map(sku),
          labelBlockers: r.blockers,
        },
        sources: [
          { label: `${r.recipe.code} nutrition`, href: `/recipes/${i.recipeId}/nutrition` },
        ],
      };
    },
  }),
  tool({
    definition: {
      name: "allergen_matrix",
      description:
        "Every active recipe's status for one allergen (or all 14): CONTAINS, MAY_CONTAIN, FREE_FROM or UNKNOWN. Use it for questions like 'which dishes contain sesame?' or 'what can a guest with a milk allergy have?'.",
      input_schema: schema({
        allergen: {
          type: "string",
          description: "Optional allergen code; empty for all.",
          enum: [...ALLERGEN_CODES],
        },
      }),
      strict: true,
    },
    input: z
      .object({ allergen: z.enum(ALLERGEN_CODES as [string, ...string[]]).optional() })
      .strict(),
    async run(ctx, i) {
      const rows = await allergenMatrix(ctx);
      return {
        data: {
          note: "FREE_FROM only when every ingredient has a verified free-from statement; UNKNOWN must be checked.",
          recipes: rows.map((r) => ({
            code: r.recipe.code,
            name: r.recipe.name,
            nameAr: r.recipe.nameAr,
            type: r.recipe.type,
            allergens: Object.fromEntries(
              Object.entries(r.allergens)
                .filter(([code]) => !i.allergen || code === i.allergen)
                .map(([code, a]) => [code, a.status]),
            ),
          })),
        },
        sources: [{ label: "Allergen matrix", href: "/recipes/allergens" }],
      };
    },
  }),
] as const;

export const CONSULTANT_TOOL_DEFINITIONS: BetaTool[] = CONSULTANT_TOOLS.map((t) => t.definition);

export async function runConsultantTool(
  ctx: TenantContext,
  name: string,
  rawInput: unknown,
): Promise<ToolResult> {
  return runToolFrom(CONSULTANT_TOOLS, ctx, name, rawInput);
}
