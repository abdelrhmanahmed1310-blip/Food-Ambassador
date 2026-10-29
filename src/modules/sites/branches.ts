import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { accessibleScope, assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, diff, recordAudit } from "@/modules/audit/service";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { branchSchema, createBranchSchema, type ListStatus } from "./schemas";

export const PAGE_SIZE = 20;

const branchSelect = {
  id: true,
  code: true,
  name: true,
  type: true,
  timeZone: true,
  addressLine: true,
  city: true,
  country: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BranchSelect;

export type BranchView = Prisma.BranchGetPayload<{ select: typeof branchSelect }>;

function archivedFilter(status: ListStatus) {
  return status === "active"
    ? { archivedAt: null }
    : status === "archived"
      ? { archivedAt: { not: null } }
      : {};
}

/** Branch IDs the user may view: all (undefined) or an explicit list. */
function visibleBranchFilter(ctx: TenantContext): Prisma.BranchWhereInput {
  const scope = accessibleScope(ctx.grants, "branches.view");
  return scope.all ? {} : { id: { in: scope.branchIds } };
}

export async function listBranches(
  ctx: TenantContext,
  options: { q?: string; status?: ListStatus; page?: number } = {},
) {
  const page = Math.max(1, options.page ?? 1);
  const q = options.q?.trim();
  const where: Prisma.BranchWhereInput = {
    organizationId: ctx.organizationId,
    ...visibleBranchFilter(ctx),
    ...archivedFilter(options.status ?? "active"),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { code: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.branch.count({ where }),
      tx.branch.findMany({
        where,
        select: {
          ...branchSelect,
          _count: { select: { warehouses: { where: { archivedAt: null } } } },
        },
        orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { code: "asc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return { items, total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
  });
}

/** Lookup scoped to the tenant AND to what the user may see; anything else is "not found". */
async function findVisibleBranch(
  tx: Tx,
  ctx: TenantContext,
  branchId: string,
): Promise<BranchView> {
  const branch = await tx.branch.findFirst({
    where: { organizationId: ctx.organizationId, id: branchId },
    select: branchSelect,
  });
  if (!branch || !hasPermission(ctx.grants, "branches.view", { branchId }))
    throw notFound("Branch");
  return branch;
}

export async function getBranch(ctx: TenantContext, branchId: string): Promise<BranchView> {
  return withTenantTx(ctx.organizationId, (tx) => findVisibleBranch(tx, ctx, branchId));
}

function codeConflict(error: unknown): never {
  if (isUniqueViolation(error, "_code_key"))
    throw conflict("A record with this code already exists", {
      field: "code",
      reason: "codeTaken",
    });
  throw error;
}

export async function createBranch(ctx: TenantContext, rawInput: unknown): Promise<{ id: string }> {
  assertPermission(ctx.grants, "branches.manage");
  const parsed = createBranchSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  try {
    return await runIdempotent(
      ctx,
      { key: idempotencyKey, operation: "branch.create", input },
      async (tx) => {
        const branch = await tx.branch.create({
          data: {
            ...input,
            organizationId: ctx.organizationId,
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          },
          select: { id: true },
        });
        await recordAudit(tx, actorOf(ctx), {
          action: "branch.created",
          entityType: "branch",
          entityId: branch.id,
          changes: input,
        });
        return { id: branch.id };
      },
    );
  } catch (error) {
    codeConflict(error);
  }
}

export async function updateBranch(
  ctx: TenantContext,
  branchId: string,
  rawInput: unknown,
): Promise<void> {
  const parsed = branchSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  // Optional fields left empty are cleared, not ignored.
  const input = {
    ...parsed.data,
    timeZone: parsed.data.timeZone ?? null,
    addressLine: parsed.data.addressLine ?? null,
    city: parsed.data.city ?? null,
    country: parsed.data.country ?? null,
  };
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const before = await findVisibleBranch(tx, ctx, branchId);
      assertPermission(ctx.grants, "branches.manage", { branchId });
      await tx.branch.update({
        where: { organizationId_id: { organizationId: ctx.organizationId, id: branchId } },
        data: { ...input, updatedByUserId: ctx.userId },
      });
      const changes = diff(before, input);
      if (Object.keys(changes).length > 0) {
        await recordAudit(tx, actorOf(ctx), {
          action: "branch.updated",
          entityType: "branch",
          entityId: branchId,
          changes,
        });
      }
    });
  } catch (error) {
    codeConflict(error);
  }
}

export async function setBranchArchived(
  ctx: TenantContext,
  branchId: string,
  archived: boolean,
): Promise<void> {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await findVisibleBranch(tx, ctx, branchId);
    assertPermission(ctx.grants, "branches.manage", { branchId });
    if (archived === (branch.archivedAt !== null)) return;
    if (archived) {
      const activeWarehouses = await tx.warehouse.count({
        where: { organizationId: ctx.organizationId, branchId, archivedAt: null },
      });
      if (activeWarehouses > 0) {
        throw businessRuleViolation(
          "BRANCH_HAS_ACTIVE_WAREHOUSES",
          "Archive this branch's warehouses first",
          { activeWarehouses },
        );
      }
    }
    await tx.branch.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: branchId } },
      data: { archivedAt: archived ? new Date() : null, updatedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "branch.archived" : "branch.restored",
      entityType: "branch",
      entityId: branchId,
    });
  });
}

/** Active branches the user can create warehouses in (for pickers). */
export async function listBranchOptions(
  ctx: TenantContext,
  permission: "branches.view" | "warehouses.manage" = "branches.view",
) {
  const scope = accessibleScope(ctx.grants, permission);
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(scope.all ? {} : { id: { in: scope.branchIds } }),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  );
}
