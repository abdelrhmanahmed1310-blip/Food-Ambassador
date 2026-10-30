import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { findProduct, loadUnits, quantityInBaseUnit, toUnitDef } from "@/modules/catalog/service";
import { conversionFactor } from "@/modules/catalog/units";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { createsCycle } from "./costing";
import { snapshotInTx } from "./costs";
import { createRecipeSchema, ingredientSchema, recipeSchema, versionSchema } from "./schemas";

/**
 * Recipes and their versions (DECISIONS.md ADR-030). A recipe has at most
 * one ACTIVE and one DRAFT version; only drafts change (also enforced by
 * database triggers). Activating a version retires the previous one and
 * stores a cost snapshot.
 */

export const RECIPE_PAGE_SIZE = 25;

async function audit(
  tx: Tx,
  ctx: TenantContext,
  recipe: { id: string; code: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `recipe.${action}`,
    entityType: "recipe",
    entityId: recipe.id,
    changes: { code: recipe.code, ...changes },
  });
}

function codeConflict(error: unknown): never {
  if (isUniqueViolation(error, "recipes_organization_id_code_key"))
    throw conflict("A recipe with this code already exists", {
      reason: "duplicate",
      field: "code",
    });
  throw error;
}

async function lockRecipe(tx: Tx, ctx: TenantContext, recipeId: string) {
  await tx.$queryRaw`
    SELECT "id" FROM "recipes"
    WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${recipeId}::uuid
    FOR UPDATE`;
  const recipe = await tx.recipe.findFirst({
    where: { organizationId: ctx.organizationId, id: recipeId },
    include: { versions: { orderBy: { versionNo: "asc" } } },
  });
  if (!recipe) throw notFound("Recipe");
  return recipe;
}

/** Load a version for a change: lock its recipe, require a draft. */
async function lockDraft(tx: Tx, ctx: TenantContext, versionId: string) {
  const found = await tx.recipeVersion.findFirst({
    where: { organizationId: ctx.organizationId, id: versionId },
    select: { recipeId: true },
  });
  if (!found) throw notFound("Recipe version");
  const recipe = await lockRecipe(tx, ctx, found.recipeId);
  const version = recipe.versions.find((v) => v.id === versionId);
  if (!version) throw notFound("Recipe version");
  if (version.status !== "DRAFT")
    throw businessRuleViolation("RECIPE_VERSION_NOT_DRAFT", "Only draft versions can change", {
      status: version.status,
    });
  return { recipe, version };
}

/** Recipe → sub-recipes used by its active version (organization-wide). */
async function activeUses(tx: Tx, ctx: TenantContext) {
  const rows = await tx.recipeIngredient.findMany({
    where: {
      organizationId: ctx.organizationId,
      subRecipeId: { not: null },
      version: { status: "ACTIVE" },
    },
    select: { subRecipeId: true, version: { select: { recipeId: true } } },
  });
  const uses = new Map<string, string[]>();
  for (const r of rows) {
    const list = uses.get(r.version.recipeId) ?? [];
    list.push(r.subRecipeId as string);
    uses.set(r.version.recipeId, list);
  }
  return uses;
}

/** Serialize changes to the sub-recipe graph within the organization. */
async function lockRecipeGraph(tx: Tx, ctx: TenantContext) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recipe-graph:${ctx.organizationId}`}))`;
}

function requireYield(type: "DISH" | "PREPARATION", portions: string | undefined | null) {
  if (type === "DISH" && !portions)
    throw businessRuleViolation("DISH_NEEDS_PORTIONS", "A dish needs the number of portions", {
      field: "portions",
    });
}

async function assertYieldUnit(tx: Tx, ctx: TenantContext, uomId: string) {
  const unit = (await loadUnits(tx, ctx)).find((u) => u.id === uomId);
  if (!unit) throw notFound("Unit");
  // Yields must be in a unit of fixed size, so sub-recipe quantities convert.
  if (unit.factorToBase === null)
    throw businessRuleViolation("YIELD_UNIT_NOT_FIXED", "Use a unit of fixed size for the yield", {
      field: "yieldUomId",
    });
}

// ─── Recipes ───

export async function createRecipe(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "recipes.manage");
  const parsed = createRecipeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, yieldQuantity, yieldUomId, portions, note, ...recipe } = parsed.data;
  try {
    return await runIdempotent(
      ctx,
      { key: idempotencyKey, operation: "recipe.create", input: parsed.data },
      async (tx) => {
        await assertYieldUnit(tx, ctx, yieldUomId);
        const created = await tx.recipe.create({
          data: { ...recipe, organizationId: ctx.organizationId },
          select: { id: true, code: true },
        });
        const version = await tx.recipeVersion.create({
          data: {
            organizationId: ctx.organizationId,
            recipeId: created.id,
            versionNo: 1,
            yieldQuantity,
            yieldUomId,
            portions: portions ?? null,
            note,
            createdByUserId: ctx.userId,
          },
          select: { id: true },
        });
        await audit(tx, ctx, created, "created", { type: recipe.type, versionId: version.id });
        return { id: created.id, versionId: version.id };
      },
    );
  } catch (error) {
    codeConflict(error);
  }
}

export async function updateRecipe(ctx: TenantContext, recipeId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "recipes.manage");
  const parsed = recipeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const recipe = await lockRecipe(tx, ctx, recipeId);
    await tx.recipe.update({
      where: { id: recipe.id },
      data: {
        name: parsed.data.name,
        nameAr: parsed.data.nameAr ?? null,
        description: parsed.data.description ?? null,
      },
    });
    await audit(tx, ctx, recipe, "updated", parsed.data);
  });
}

export async function setRecipeArchived(ctx: TenantContext, recipeId: string, archived: boolean) {
  assertPermission(ctx.grants, "recipes.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const recipe = await lockRecipe(tx, ctx, recipeId);
    if (archived) {
      const usedBy = await tx.recipeIngredient.count({
        where: {
          organizationId: ctx.organizationId,
          subRecipeId: recipe.id,
          version: { status: { in: ["ACTIVE", "DRAFT"] }, recipe: { archivedAt: null } },
        },
      });
      if (usedBy > 0)
        throw businessRuleViolation("RECIPE_IN_USE", "Other recipes use this one", {
          count: usedBy,
        });
    }
    await tx.recipe.update({
      where: { id: recipe.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await audit(tx, ctx, recipe, archived ? "archived" : "restored");
  });
}

export async function listRecipes(
  ctx: TenantContext,
  options: { q?: string; type?: "DISH" | "PREPARATION"; archived?: boolean; page?: number } = {},
) {
  assertPermission(ctx.grants, "recipes.view");
  const page = Math.max(1, options.page ?? 1);
  const q = options.q?.trim();
  const where: Prisma.RecipeWhereInput = {
    organizationId: ctx.organizationId,
    archivedAt: options.archived ? { not: null } : null,
    ...(options.type ? { type: options.type } : {}),
    ...(q
      ? {
          OR: [
            { code: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
            { nameAr: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.recipe.count({ where }),
      tx.recipe.findMany({
        where,
        select: {
          id: true,
          code: true,
          name: true,
          nameAr: true,
          type: true,
          archivedAt: true,
          versions: {
            where: { status: { in: ["ACTIVE", "DRAFT"] } },
            select: {
              id: true,
              versionNo: true,
              status: true,
              yieldQuantity: true,
              portions: true,
              yieldUom: { select: { code: true } },
            },
          },
        },
        orderBy: { code: "asc" },
        skip: (page - 1) * RECIPE_PAGE_SIZE,
        take: RECIPE_PAGE_SIZE,
      }),
    ]);
    return { items, total, page, pageCount: Math.max(1, Math.ceil(total / RECIPE_PAGE_SIZE)) };
  });
}

export async function getRecipe(ctx: TenantContext, recipeId: string) {
  assertPermission(ctx.grants, "recipes.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const recipe = await tx.recipe.findFirst({
      where: { organizationId: ctx.organizationId, id: recipeId },
      include: {
        versions: {
          orderBy: { versionNo: "desc" },
          include: {
            yieldUom: { select: { code: true } },
            _count: { select: { ingredients: true } },
          },
        },
        usedIn: {
          where: { version: { status: { in: ["ACTIVE", "DRAFT"] } } },
          select: {
            version: {
              select: {
                id: true,
                versionNo: true,
                status: true,
                recipe: { select: { id: true, code: true, name: true, nameAr: true } },
              },
            },
          },
        },
      },
    });
    if (!recipe) throw notFound("Recipe");
    const manage = hasPermission(ctx.grants, "recipes.manage");
    return {
      ...recipe,
      can: {
        edit: manage && !recipe.archivedAt,
        newVersion:
          manage && !recipe.archivedAt && !recipe.versions.some((v) => v.status === "DRAFT"),
        archive: manage,
      },
    };
  });
}

// ─── Versions ───

export async function getVersion(ctx: TenantContext, versionId: string) {
  assertPermission(ctx.grants, "recipes.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const version = await tx.recipeVersion.findFirst({
      where: { organizationId: ctx.organizationId, id: versionId },
      include: {
        recipe: true,
        yieldUom: { select: { id: true, code: true } },
        ingredients: {
          orderBy: { lineNo: "asc" },
          include: {
            product: {
              select: {
                id: true,
                sku: true,
                nameEn: true,
                nameAr: true,
                archivedAt: true,
                baseUom: { select: { code: true } },
              },
            },
            subRecipe: {
              select: { id: true, code: true, name: true, nameAr: true, archivedAt: true },
            },
            uom: { select: { code: true } },
          },
        },
      },
    });
    if (!version) throw notFound("Recipe version");
    const users = await tx.user.findMany({
      where: {
        id: {
          in: [version.createdByUserId, version.activatedByUserId].filter((v): v is string => !!v),
        },
      },
      select: { id: true, name: true },
    });
    const name = (id: string | null) =>
      id ? (users.find((u) => u.id === id)?.name ?? null) : null;
    const manage = hasPermission(ctx.grants, "recipes.manage") && !version.recipe.archivedAt;
    return {
      ...version,
      names: {
        createdBy: name(version.createdByUserId),
        activatedBy: name(version.activatedByUserId),
      },
      can: {
        edit: manage && version.status === "DRAFT",
        activate: manage && version.status === "DRAFT" && version.ingredients.length > 0,
        costs: hasPermission(ctx.grants, "recipes.costs.view"),
      },
    };
  });
}

export async function updateVersion(ctx: TenantContext, versionId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "recipes.manage");
  const parsed = versionSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { recipe, version } = await lockDraft(tx, ctx, versionId);
    requireYield(recipe.type, parsed.data.portions);
    await assertYieldUnit(tx, ctx, parsed.data.yieldUomId);
    await tx.recipeVersion.update({
      where: { id: version.id },
      data: {
        yieldQuantity: parsed.data.yieldQuantity,
        yieldUomId: parsed.data.yieldUomId,
        portions: parsed.data.portions ?? null,
        note: parsed.data.note ?? null,
      },
    });
    await audit(tx, ctx, recipe, "version_updated", {
      versionNo: version.versionNo,
      ...parsed.data,
    });
  });
}

export async function addIngredient(ctx: TenantContext, versionId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "recipes.manage");
  const parsed = ingredientSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    await lockRecipeGraph(tx, ctx);
    const { recipe, version } = await lockDraft(tx, ctx, versionId);
    if (input.productId) {
      const product = await findProduct(tx, ctx, input.productId);
      if (product.archivedAt)
        throw businessRuleViolation("PRODUCT_ARCHIVED", "The product is archived", {
          field: "item",
        });
      // Validates that the unit converts to the product's base unit.
      await quantityInBaseUnit(tx, ctx, product, input.uomId, input.quantity);
    } else {
      const sub = await tx.recipe.findFirst({
        where: { organizationId: ctx.organizationId, id: input.subRecipeId as string },
        include: { versions: { where: { status: "ACTIVE" }, include: { yieldUom: true } } },
      });
      if (!sub) throw notFound("Recipe");
      if (sub.type !== "PREPARATION" || sub.archivedAt)
        throw businessRuleViolation(
          "SUB_RECIPE_NOT_USABLE",
          "Only active preparations can be used as sub-recipes",
          { field: "item" },
        );
      const draftSubs = await tx.recipeIngredient.findMany({
        where: {
          organizationId: ctx.organizationId,
          versionId: version.id,
          subRecipeId: { not: null },
        },
        select: { subRecipeId: true },
      });
      const uses = await activeUses(tx, ctx);
      uses.set(
        recipe.id,
        draftSubs.map((d) => d.subRecipeId as string),
      );
      if (createsCycle(recipe.id, sub.id, uses))
        throw businessRuleViolation("RECIPE_CYCLE", "A recipe cannot contain itself", {
          field: "item",
        });
      const active = sub.versions[0];
      if (active) {
        const units = await loadUnits(tx, ctx, true);
        const from = units.find((u) => u.id === input.uomId);
        if (!from) throw notFound("Unit");
        conversionFactor(toUnitDef(from), toUnitDef(active.yieldUom), []);
      }
    }
    const last = await tx.recipeIngredient.findFirst({
      where: { organizationId: ctx.organizationId, versionId: version.id },
      orderBy: { lineNo: "desc" },
      select: { lineNo: true },
    });
    const lineNo = (last?.lineNo ?? 0) + 1;
    await tx.recipeIngredient.create({
      data: {
        organizationId: ctx.organizationId,
        versionId: version.id,
        lineNo,
        productId: input.productId,
        subRecipeId: input.subRecipeId,
        quantity: input.quantity,
        uomId: input.uomId,
        wasteFraction: input.wasteFraction,
        note: input.note,
      },
    });
    await audit(tx, ctx, recipe, "ingredient_added", {
      versionNo: version.versionNo,
      lineNo,
      ...input,
    });
  });
}

export async function removeIngredient(
  ctx: TenantContext,
  versionId: string,
  ingredientId: string,
) {
  assertPermission(ctx.grants, "recipes.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { recipe, version } = await lockDraft(tx, ctx, versionId);
    const line = await tx.recipeIngredient.findFirst({
      where: { organizationId: ctx.organizationId, versionId: version.id, id: ingredientId },
    });
    if (!line) throw notFound("Ingredient");
    await tx.recipeIngredient.delete({ where: { id: line.id } });
    await audit(tx, ctx, recipe, "ingredient_removed", {
      versionNo: version.versionNo,
      lineNo: line.lineNo,
    });
  });
}

/**
 * Activate a draft: it must have ingredients (and portions for a dish), and
 * none of its sub-recipes may lead back to this recipe. The previous active
 * version is retired and a cost snapshot is stored.
 */
export async function activateVersion(ctx: TenantContext, versionId: string) {
  assertPermission(ctx.grants, "recipes.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    await lockRecipeGraph(tx, ctx);
    const { recipe, version } = await lockDraft(tx, ctx, versionId);
    if (recipe.archivedAt) throw businessRuleViolation("RECIPE_ARCHIVED", "The recipe is archived");
    requireYield(recipe.type, version.portions?.toString());
    const ingredients = await tx.recipeIngredient.findMany({
      where: { organizationId: ctx.organizationId, versionId: version.id },
      select: { subRecipeId: true },
    });
    if (ingredients.length === 0)
      throw businessRuleViolation("RECIPE_HAS_NO_INGREDIENTS", "Add at least one ingredient first");
    const subs = ingredients.flatMap((i) => (i.subRecipeId ? [i.subRecipeId] : []));
    const uses = await activeUses(tx, ctx);
    uses.set(recipe.id, subs);
    if (subs.some((s) => createsCycle(recipe.id, s, uses)))
      throw businessRuleViolation("RECIPE_CYCLE", "A recipe cannot contain itself");
    const now = new Date();
    const previous = recipe.versions.find((v) => v.status === "ACTIVE");
    if (previous)
      await tx.recipeVersion.update({
        where: { id: previous.id },
        data: { status: "RETIRED", retiredAt: now },
      });
    await tx.recipeVersion.update({
      where: { id: version.id },
      data: { status: "ACTIVE", activatedAt: now, activatedByUserId: ctx.userId },
    });
    const snapshot = await snapshotInTx(tx, ctx, version.id, {
      reason: "ACTIVATION",
      policy: "AVERAGE",
      warehouseId: undefined,
    });
    await audit(tx, ctx, recipe, "version_activated", {
      versionNo: version.versionNo,
      retiredVersionNo: previous?.versionNo ?? null,
      snapshotId: snapshot.id,
    });
    return { snapshotId: snapshot.id };
  });
}

/** Start a new draft from the active (or latest) version, copying its ingredients. */
export async function createDraftVersion(ctx: TenantContext, recipeId: string) {
  assertPermission(ctx.grants, "recipes.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const recipe = await lockRecipe(tx, ctx, recipeId);
    if (recipe.archivedAt) throw businessRuleViolation("RECIPE_ARCHIVED", "The recipe is archived");
    if (recipe.versions.some((v) => v.status === "DRAFT"))
      throw businessRuleViolation("RECIPE_HAS_DRAFT", "Finish or discard the current draft first");
    const from =
      recipe.versions.find((v) => v.status === "ACTIVE") ??
      recipe.versions[recipe.versions.length - 1];
    const versionNo = recipe.versions[recipe.versions.length - 1].versionNo + 1;
    const draft = await tx.recipeVersion.create({
      data: {
        organizationId: ctx.organizationId,
        recipeId: recipe.id,
        versionNo,
        yieldQuantity: from.yieldQuantity,
        yieldUomId: from.yieldUomId,
        portions: from.portions,
        note: from.note,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    const lines = await tx.recipeIngredient.findMany({
      where: { organizationId: ctx.organizationId, versionId: from.id },
      orderBy: { lineNo: "asc" },
    });
    if (lines.length > 0)
      await tx.recipeIngredient.createMany({
        data: lines.map((l) => ({
          organizationId: ctx.organizationId,
          versionId: draft.id,
          lineNo: l.lineNo,
          productId: l.productId,
          subRecipeId: l.subRecipeId,
          quantity: l.quantity,
          uomId: l.uomId,
          wasteFraction: l.wasteFraction,
          note: l.note,
        })),
      });
    await audit(tx, ctx, recipe, "version_created", { versionNo, from: from.versionNo });
    return { id: draft.id, versionNo };
  });
}

export async function discardDraft(ctx: TenantContext, versionId: string) {
  assertPermission(ctx.grants, "recipes.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { recipe, version } = await lockDraft(tx, ctx, versionId);
    if (recipe.versions.length === 1)
      throw businessRuleViolation(
        "RECIPE_NEEDS_VERSION",
        "The first version cannot be discarded; archive the recipe instead",
      );
    await tx.recipeVersion.delete({ where: { id: version.id } });
    await audit(tx, ctx, recipe, "version_discarded", { versionNo: version.versionNo });
    return { recipeId: recipe.id };
  });
}

/** Preparations that can be picked as sub-recipes for `recipeId`. */
export async function subRecipeOptions(ctx: TenantContext, recipeId: string) {
  assertPermission(ctx.grants, "recipes.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.recipe.findMany({
      where: {
        organizationId: ctx.organizationId,
        type: "PREPARATION",
        archivedAt: null,
        id: { not: recipeId },
      },
      select: { id: true, code: true, name: true, nameAr: true },
      orderBy: { code: "asc" },
    }),
  );
}
