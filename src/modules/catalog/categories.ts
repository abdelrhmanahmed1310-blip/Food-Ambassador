import "server-only";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, diff, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx } from "@/server/db/transactions";
import { conflict, notFound, validationFailed } from "@/server/errors";
import { categorySchema } from "./schemas";

/** Product categories: a flat list per organization (DECISIONS.md ADR-025). */

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
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.productCategory.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(options.includeArchived ? {} : { archivedAt: null }),
      },
      include: { _count: { select: { products: { where: { archivedAt: null } } } } },
      orderBy: { code: "asc" },
    }),
  );
}

export async function getCategory(ctx: TenantContext, categoryId: string) {
  assertPermission(ctx.grants, "catalog.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const category = await tx.productCategory.findFirst({
      where: { organizationId: ctx.organizationId, id: categoryId },
    });
    if (!category) throw notFound("Category");
    return category;
  });
}

export async function createCategory(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "catalog.manage");
  const parsed = categorySchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const category = await tx.productCategory.create({
        data: { ...parsed.data, organizationId: ctx.organizationId },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "category.created",
        entityType: "category",
        entityId: category.id,
        changes: parsed.data,
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
  const input = { ...parsed.data, nameAr: parsed.data.nameAr ?? null };
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const before = await tx.productCategory.findFirst({
        where: { organizationId: ctx.organizationId, id: categoryId },
      });
      if (!before) throw notFound("Category");
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

/** Archiving hides the category from pickers; products keep it until changed. */
export async function setCategoryArchived(
  ctx: TenantContext,
  categoryId: string,
  archived: boolean,
) {
  assertPermission(ctx.grants, "catalog.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const category = await tx.productCategory.findFirst({
      where: { organizationId: ctx.organizationId, id: categoryId },
    });
    if (!category) throw notFound("Category");
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
