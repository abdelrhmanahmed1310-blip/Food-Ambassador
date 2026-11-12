import "server-only";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, diff, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { descendants, MAX_CATEGORY_DEPTH, placementProblem, treeOrder } from "./category-tree";
import { categorySchema } from "./schemas";

/**
 * Product categories (DECISIONS.md ADR-025, ADR-134): a tree of up to three
 * levels per organization, e.g. Beverages › Hot drinks › Coffee. Filtering
 * by a category includes its subcategories.
 */

function codeConflict(error: unknown): never {
  if (isUniqueViolation(error, "product_categories_organization_id_code_key"))
    throw conflict("A category with this code already exists", {
      field: "code",
      reason: "codeTaken",
    });
  throw error;
}

export async function listCategories(
  ctx: TenantContext,
  options: { includeArchived?: boolean } = {},
) {
  assertPermission(ctx.grants, "catalog.view");
  const rows = await withTenantTx(ctx.organizationId, (tx) =>
    tx.productCategory.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(options.includeArchived ? {} : { archivedAt: null }),
      },
      include: { _count: { select: { products: { where: { archivedAt: null } } } } },
      orderBy: { code: "asc" },
    }),
  );
  // Parents first, each followed by its subcategories, with depth and full path.
  return treeOrder(rows);
}

export async function getCategory(ctx: TenantContext, categoryId: string) {
  assertPermission(ctx.grants, "catalog.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const category = await tx.productCategory.findFirst({
      where: { organizationId: ctx.organizationId, id: categoryId },
      include: {
        parent: { select: { id: true, code: true, name: true, nameAr: true } },
        subcategories: {
          select: { id: true, code: true, name: true, nameAr: true, archivedAt: true },
          orderBy: { code: "asc" },
        },
      },
    });
    if (!category) throw notFound("Category");
    return category;
  });
}

/** The category with every subcategory under it, for filters (ADR-134). */
export async function categoryWithSubcategoriesInTx(
  tx: Tx,
  ctx: TenantContext,
  categoryId: string,
): Promise<string[]> {
  const nodes = await tx.productCategory.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, parentId: true },
  });
  return [categoryId, ...descendants(categoryId, nodes)];
}

/** Each category with its ancestors, nearest first (for put-away rules on a parent). */
export async function categoryParentsInTx(tx: Tx, ctx: TenantContext) {
  const nodes = await tx.productCategory.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, parentId: true },
  });
  return new Map(nodes.map((n) => [n.id, n.parentId]));
}

/** Check a parent: in this organization, active, and no loop or fourth level. */
async function assertPlacement(
  tx: Tx,
  ctx: TenantContext,
  categoryId: string | null,
  parentId: string | null | undefined,
) {
  const nodes = await tx.productCategory.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, parentId: true, archivedAt: true },
  });
  if (parentId) {
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) throw notFound("Category");
    if (parent.archivedAt)
      throw businessRuleViolation("CATEGORY_ARCHIVED", "The parent category is archived", {
        field: "parentId",
      });
  }
  const problem = placementProblem(categoryId, parentId ?? null, nodes);
  if (problem)
    throw businessRuleViolation(
      problem,
      problem === "CATEGORY_LOOP"
        ? "A category cannot be placed under its own subcategory"
        : `Categories are at most ${MAX_CATEGORY_DEPTH} levels deep`,
      { field: "parentId", max: MAX_CATEGORY_DEPTH },
    );
}

export async function createCategory(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "catalog.manage");
  const parsed = categorySchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = { ...parsed.data, parentId: parsed.data.parentId ?? null };
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      await assertPlacement(tx, ctx, null, input.parentId);
      const category = await tx.productCategory.create({
        data: { ...input, organizationId: ctx.organizationId },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "category.created",
        entityType: "category",
        entityId: category.id,
        changes: input,
      });
      return category;
    });
  } catch (error) {
    codeConflict(error);
  }
}

export async function updateCategory(ctx: TenantContext, categoryId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "catalog.manage");
  const parsed = categorySchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = {
    ...parsed.data,
    nameAr: parsed.data.nameAr ?? null,
    parentId: parsed.data.parentId ?? null,
  };
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const before = await tx.productCategory.findFirst({
        where: { organizationId: ctx.organizationId, id: categoryId },
      });
      if (!before) throw notFound("Category");
      if (input.parentId !== before.parentId)
        await assertPlacement(tx, ctx, before.id, input.parentId);
      await tx.productCategory.update({ where: { id: before.id }, data: input });
      const changes = diff(before as unknown as Record<string, unknown>, input);
      if (Object.keys(changes).length > 0)
        await recordAudit(tx, actorOf(ctx), {
          action: "category.updated",
          entityType: "category",
          entityId: before.id,
          changes,
        });
    });
  } catch (error) {
    codeConflict(error);
  }
}

/**
 * Archiving hides the category from pickers; products keep it until changed.
 * A category with active subcategories is not archived: archive or move them first.
 */
export async function setCategoryArchived(
  ctx: TenantContext,
  categoryId: string,
  archived: boolean,
) {
  assertPermission(ctx.grants, "catalog.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const category = await tx.productCategory.findFirst({
      where: { organizationId: ctx.organizationId, id: categoryId },
      include: { parent: { select: { archivedAt: true } } },
    });
    if (!category) throw notFound("Category");
    if (archived) {
      const active = await tx.productCategory.count({
        where: { organizationId: ctx.organizationId, parentId: category.id, archivedAt: null },
      });
      if (active > 0)
        throw businessRuleViolation(
          "CATEGORY_HAS_SUBCATEGORIES",
          "Archive or move its subcategories first",
          { count: active },
        );
    } else if (category.parent?.archivedAt)
      throw businessRuleViolation("CATEGORY_ARCHIVED", "Restore the parent category first");
    await tx.productCategory.update({
      where: { id: category.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "category.archived" : "category.restored",
      entityType: "category",
      entityId: category.id,
    });
  });
}
