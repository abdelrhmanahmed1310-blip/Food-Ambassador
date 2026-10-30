import "server-only";
import { Decimal, roundQuantity, toDecimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { findProduct, loadUnits, toUnitDef } from "@/modules/catalog/service";
import { conversionFactor } from "@/modules/catalog/units";
import { businessDate } from "@/modules/inventory/rules";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { usesProduct, type CostPolicy, type VersionCost } from "./costing";
import { costVersionsInTx } from "./costs";
import { dishEconomics } from "./pricing";
import { activateInTx, createDraftInTx } from "./recipes";
import {
  bulkReplaceSchema,
  costQuerySchema,
  recipePriceSchema,
  simulationSchema,
  targetSchema,
} from "./schemas";

/**
 * Selling prices, food cost targets, the food cost report, the price
 * simulator and bulk ingredient replacement (DECISIONS.md ADR-032).
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());

// ─── Prices and targets ───

export async function addRecipePrice(ctx: TenantContext, recipeId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "recipes.manage");
  const parsed = recipePriceSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  try {
    return await runIdempotent(
      ctx,
      { key: idempotencyKey, operation: "recipe.price", input: { recipeId, ...input } },
      async (tx) => {
        const recipe = await tx.recipe.findFirst({
          where: { organizationId: ctx.organizationId, id: recipeId },
          select: { id: true, code: true, type: true },
        });
        if (!recipe) throw notFound("Recipe");
        if (recipe.type !== "DISH")
          throw businessRuleViolation("RECIPE_NOT_DISH", "Only dishes have selling prices");
        const row = await tx.recipePrice.create({
          data: {
            organizationId: ctx.organizationId,
            recipeId: recipe.id,
            price: input.price,
            effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`),
            note: input.note,
            createdByUserId: ctx.userId,
          },
          select: { id: true },
        });
        await recordAudit(tx, actorOf(ctx), {
          action: "recipe.price_added",
          entityType: "recipe",
          entityId: recipe.id,
          changes: { code: recipe.code, ...input },
        });
        return row;
      },
    );
  } catch (error) {
    if (isUniqueViolation(error, "recipe_prices_organization_id_recipe_id_effective_from_key"))
      throw conflict("A price already starts on this date", {
        reason: "duplicate",
        field: "effectiveFrom",
      });
    throw error;
  }
}

export async function listRecipePrices(ctx: TenantContext, recipeId: string) {
  assertPermission(ctx.grants, "recipes.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.recipePrice.findMany({
      where: { organizationId: ctx.organizationId, recipeId },
      select: { id: true, price: true, effectiveFrom: true, note: true },
      orderBy: { effectiveFrom: "desc" },
      take: 50,
    }),
  );
}

/** Price in effect today per recipe. */
async function currentPrices(tx: Tx, ctx: TenantContext, recipeIds: string[]) {
  if (recipeIds.length === 0) return new Map<string, Decimal>();
  const rows = await tx.$queryRaw<Array<{ recipe_id: string; price: string }>>`
    SELECT DISTINCT ON ("recipe_id") "recipe_id", "price"::text
    FROM "recipe_prices"
    WHERE "organization_id" = ${ctx.organizationId}::uuid
      AND "recipe_id" = ANY(${recipeIds}::uuid[])
      AND "effective_from" <= ${businessDate(ctx.timeZone)}::date
    ORDER BY "recipe_id", "effective_from" DESC`;
  return new Map(rows.map((r) => [r.recipe_id, new Decimal(r.price)]));
}

export async function getRecipeSettings(ctx: TenantContext) {
  assertPermission(ctx.grants, "recipes.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await tx.recipeSettings.findUnique({ where: { organizationId: ctx.organizationId } });
    return { targetFoodCostFraction: s?.targetFoodCostFraction ?? null };
  });
}

export async function updateRecipeSettings(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "recipes.manage");
  const parsed = targetSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const target = parsed.data.targetPercent;
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.recipeSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, targetFoodCostFraction: target },
      update: { targetFoodCostFraction: target },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "recipe.settings_updated",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: { targetFoodCostFraction: target },
    });
  });
}

/** Target for one recipe; blank falls back to the organization's. */
export async function setRecipeTarget(ctx: TenantContext, recipeId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "recipes.manage");
  const parsed = targetSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const recipe = await tx.recipe.findFirst({
      where: { organizationId: ctx.organizationId, id: recipeId },
      select: { id: true, code: true },
    });
    if (!recipe) throw notFound("Recipe");
    await tx.recipe.update({
      where: { id: recipe.id },
      data: { targetFoodCostFraction: parsed.data.targetPercent },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "recipe.target_updated",
      entityType: "recipe",
      entityId: recipe.id,
      changes: { code: recipe.code, targetFoodCostFraction: parsed.data.targetPercent },
    });
  });
}

// ─── Food cost report and simulator ───

async function activeDishes(tx: Tx, ctx: TenantContext) {
  return tx.recipe.findMany({
    where: {
      organizationId: ctx.organizationId,
      type: "DISH",
      archivedAt: null,
      versions: { some: { status: "ACTIVE" } },
    },
    select: {
      id: true,
      code: true,
      name: true,
      nameAr: true,
      targetFoodCostFraction: true,
      versions: { where: { status: "ACTIVE" }, select: { id: true, versionNo: true } },
    },
    orderBy: { code: "asc" },
    take: 500,
  });
}

function row(
  dish: Awaited<ReturnType<typeof activeDishes>>[number],
  cost: VersionCost,
  price: Decimal | null,
  orgTarget: Decimal | null,
) {
  const target = dish.targetFoodCostFraction ? dec(dish.targetFoodCostFraction) : orgTarget;
  const costPerPortion = new Decimal(cost.costPerPortion ?? cost.totalCost);
  return {
    costPerPortion,
    missingCount: cost.missingCount,
    target,
    ...dishEconomics({ costPerPortion, missingCount: cost.missingCount, price, target }),
  };
}

/** Every active dish with cost per portion, price, food cost %, margin and status. */
export async function foodCostReport(ctx: TenantContext, rawQuery: unknown) {
  assertPermission(ctx.grants, "recipes.costs.view");
  const query = costQuerySchema.parse(rawQuery ?? {});
  return withTenantTx(ctx.organizationId, async (tx) => {
    const dishes = await activeDishes(tx, ctx);
    const settings = await tx.recipeSettings.findUnique({
      where: { organizationId: ctx.organizationId },
    });
    const orgTarget = settings?.targetFoodCostFraction
      ? dec(settings.targetFoodCostFraction)
      : null;
    const costs = await costVersionsInTx(
      tx,
      ctx,
      dishes.map((d) => d.versions[0].id),
      query,
    );
    const prices = await currentPrices(
      tx,
      ctx,
      dishes.map((d) => d.id),
    );
    const rows = dishes.map((d) => ({
      recipe: { id: d.id, code: d.code, name: d.name, nameAr: d.nameAr },
      version: d.versions[0],
      price: prices.get(d.id) ?? null,
      ...row(d, costs.get(d.versions[0].id) as VersionCost, prices.get(d.id) ?? null, orgTarget),
    }));
    return { ...query, orgTarget, rows };
  });
}

/**
 * What if a product cost `unitCost` per base unit? Dishes that use it
 * (directly or through sub-recipes), before and after. Nothing is stored.
 */
export async function simulatePrice(ctx: TenantContext, rawInput: unknown, rawQuery: unknown) {
  assertPermission(ctx.grants, "recipes.costs.view");
  const parsed = simulationSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const query = costQuerySchema.parse(rawQuery ?? {});
  return withTenantTx(ctx.organizationId, async (tx) => {
    const product = await findProduct(tx, ctx, parsed.data.productId);
    const dishes = await activeDishes(tx, ctx);
    const ids = dishes.map((d) => d.versions[0].id);
    const before = await costVersionsInTx(tx, ctx, ids, query);
    const after = await costVersionsInTx(tx, ctx, ids, {
      ...query,
      overrides: new Map([[product.id, toDecimal(parsed.data.unitCost)]]),
    });
    const settings = await tx.recipeSettings.findUnique({
      where: { organizationId: ctx.organizationId },
    });
    const orgTarget = settings?.targetFoodCostFraction
      ? dec(settings.targetFoodCostFraction)
      : null;
    const prices = await currentPrices(
      tx,
      ctx,
      dishes.map((d) => d.id),
    );
    const rows = dishes
      .filter((d) => usesProduct(before.get(d.versions[0].id) as VersionCost, product.id))
      .map((d) => {
        const price = prices.get(d.id) ?? null;
        const b = row(d, before.get(d.versions[0].id) as VersionCost, price, orgTarget);
        const a = row(d, after.get(d.versions[0].id) as VersionCost, price, orgTarget);
        return {
          recipe: { id: d.id, code: d.code, name: d.name, nameAr: d.nameAr },
          price,
          before: b,
          after: a,
          change: a.costPerPortion.minus(b.costPerPortion),
        };
      });
    return {
      product: {
        id: product.id,
        sku: product.sku,
        nameEn: product.nameEn,
        nameAr: product.nameAr,
        baseUom: product.baseUom.code,
      },
      unitCost: parsed.data.unitCost,
      policy: query.policy as CostPolicy,
      rows,
    };
  });
}

// ─── Bulk ingredient replacement ───

/** Recipes whose active version uses the product directly. */
export async function recipesUsingProduct(ctx: TenantContext, productId: string) {
  assertPermission(ctx.grants, "recipes.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.recipe.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        versions: { some: { status: "ACTIVE", ingredients: { some: { productId } } } },
      },
      select: {
        id: true,
        code: true,
        name: true,
        nameAr: true,
        type: true,
        versions: { where: { status: "DRAFT" }, select: { id: true } },
      },
      orderBy: { code: "asc" },
    }),
  );
}

export type ReplaceSkip = "HAS_DRAFT" | "NOT_USED" | "INCOMPATIBLE_UNITS";

/**
 * Replace a product by another in the active version of the chosen recipes:
 * each gets a new draft (copied from its active version) where the product's
 * lines use the new product, quantity × factor in the same unit. Recipes
 * with an open draft are skipped; the new drafts can be activated at once.
 */
export async function bulkReplaceIngredient(
  ctx: TenantContext,
  recipeIds: string[],
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "recipes.manage");
  const parsed = bulkReplaceSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  if (recipeIds.length === 0)
    throw businessRuleViolation("NOTHING_SELECTED", "Select at least one recipe");
  if (input.fromProductId === input.toProductId)
    throw businessRuleViolation("REPLACE_SAME_PRODUCT", "Choose a different product", {
      field: "toProductId",
    });
  return withTenantTx(ctx.organizationId, async (tx) => {
    const to = await findProduct(tx, ctx, input.toProductId);
    if (to.archivedAt)
      throw businessRuleViolation("PRODUCT_ARCHIVED", "The product is archived", {
        field: "toProductId",
      });
    await findProduct(tx, ctx, input.fromProductId);
    const units = await loadUnits(tx, ctx, true);
    const conversions = to.conversions.map((c) => ({
      uomId: c.uomId,
      factorToBase: c.factorToBase.toString(),
    }));
    const factor = toDecimal(input.factor);
    const done: Array<{ recipeId: string; code: string; versionId: string; activated: boolean }> =
      [];
    const skipped: Array<{ code: string; reason: ReplaceSkip }> = [];
    for (const recipeId of [...new Set(recipeIds)].sort()) {
      const recipe = await tx.recipe.findFirst({
        where: { organizationId: ctx.organizationId, id: recipeId },
        include: {
          versions: {
            where: { status: { in: ["ACTIVE", "DRAFT"] } },
            include: { ingredients: true },
          },
        },
      });
      if (!recipe) throw notFound("Recipe");
      const active = recipe.versions.find((v) => v.status === "ACTIVE");
      const lines = active?.ingredients.filter((i) => i.productId === input.fromProductId) ?? [];
      if (recipe.versions.some((v) => v.status === "DRAFT")) {
        skipped.push({ code: recipe.code, reason: "HAS_DRAFT" });
        continue;
      }
      if (lines.length === 0) {
        skipped.push({ code: recipe.code, reason: "NOT_USED" });
        continue;
      }
      const convertible = lines.every((l) => {
        const u = units.find((x) => x.id === l.uomId);
        if (!u) return false;
        try {
          conversionFactor(toUnitDef(u), toUnitDef(to.baseUom), conversions);
          return true;
        } catch {
          return false;
        }
      });
      if (!convertible) {
        skipped.push({ code: recipe.code, reason: "INCOMPATIBLE_UNITS" });
        continue;
      }
      const draft = await createDraftInTx(tx, ctx, recipe.id);
      const copied = await tx.recipeIngredient.findMany({
        where: {
          organizationId: ctx.organizationId,
          versionId: draft.id,
          productId: input.fromProductId,
        },
      });
      for (const l of copied)
        await tx.recipeIngredient.update({
          where: { id: l.id },
          data: {
            productId: to.id,
            quantity: roundQuantity(dec(l.quantity).times(factor)).toFixed(),
          },
        });
      let activated = false;
      if (input.activate) {
        await activateInTx(tx, ctx, draft.id);
        activated = true;
      }
      await recordAudit(tx, actorOf(ctx), {
        action: "recipe.ingredient_replaced",
        entityType: "recipe",
        entityId: recipe.id,
        changes: {
          code: recipe.code,
          versionNo: draft.versionNo,
          fromProductId: input.fromProductId,
          toProductId: to.id,
          factor: input.factor,
          activated,
        },
      });
      done.push({ recipeId: recipe.id, code: recipe.code, versionId: draft.id, activated });
    }
    return { done, skipped };
  });
}
