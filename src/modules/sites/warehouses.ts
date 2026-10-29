import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { accessibleScope, assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, diff, recordAudit } from "@/modules/audit/service";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { PAGE_SIZE } from "./branches";
import {
  createLocationSchema,
  createWarehouseSchema,
  locationSchema,
  updateWarehouseSchema,
  type ListStatus,
} from "./schemas";

const warehouseSelect = {
  id: true,
  branchId: true,
  code: true,
  name: true,
  type: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { id: true, code: true, name: true, archivedAt: true } },
} satisfies Prisma.WarehouseSelect;

export type WarehouseView = Prisma.WarehouseGetPayload<{ select: typeof warehouseSelect }>;

function visibleWarehouseFilter(ctx: TenantContext): Prisma.WarehouseWhereInput {
  const scope = accessibleScope(ctx.grants, "warehouses.view");
  if (scope.all) return {};
  return { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }] };
}

const target = (w: { id: string; branchId: string }) => ({
  branchId: w.branchId,
  warehouseId: w.id,
});

function codeConflict(error: unknown): never {
  if (isUniqueViolation(error, "_code_key"))
    throw conflict("A record with this code already exists", {
      field: "code",
      reason: "codeTaken",
    });
  throw error;
}

export async function listWarehouses(
  ctx: TenantContext,
  options: { q?: string; status?: ListStatus; branchId?: string; page?: number } = {},
) {
  const page = Math.max(1, options.page ?? 1);
  const q = options.q?.trim();
  const status = options.status ?? "active";
  const where: Prisma.WarehouseWhereInput = {
    AND: [
      { organizationId: ctx.organizationId },
      visibleWarehouseFilter(ctx),
      status === "active"
        ? { archivedAt: null }
        : status === "archived"
          ? { archivedAt: { not: null } }
          : {},
      options.branchId ? { branchId: options.branchId } : {},
      q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { code: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await Promise.all([
      tx.warehouse.count({ where }),
      tx.warehouse.findMany({
        where,
        select: {
          ...warehouseSelect,
          _count: { select: { locations: { where: { archivedAt: null } } } },
        },
        orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { code: "asc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return { items, total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
  });
}

async function findVisibleWarehouse(
  tx: Tx,
  ctx: TenantContext,
  warehouseId: string,
): Promise<WarehouseView> {
  const warehouse = await tx.warehouse.findFirst({
    where: { organizationId: ctx.organizationId, id: warehouseId },
    select: warehouseSelect,
  });
  if (!warehouse || !hasPermission(ctx.grants, "warehouses.view", target(warehouse)))
    throw notFound("Warehouse");
  return warehouse;
}

export async function getWarehouse(ctx: TenantContext, warehouseId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const warehouse = await findVisibleWarehouse(tx, ctx, warehouseId);
    const locations = await tx.storageLocation.findMany({
      where: { organizationId: ctx.organizationId, warehouseId },
      select: { id: true, code: true, name: true, temperatureZone: true, archivedAt: true },
      orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { code: "asc" }],
    });
    return {
      ...warehouse,
      locations,
      canManage: hasPermission(ctx.grants, "warehouses.manage", target(warehouse)),
    };
  });
}

export async function createWarehouse(
  ctx: TenantContext,
  rawInput: unknown,
): Promise<{ id: string }> {
  const parsed = createWarehouseSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  assertPermission(ctx.grants, "warehouses.manage", { branchId: input.branchId });
  try {
    return await runIdempotent(
      ctx,
      { key: idempotencyKey, operation: "warehouse.create", input },
      async (tx) => {
        const branch = await tx.branch.findFirst({
          where: { organizationId: ctx.organizationId, id: input.branchId },
          select: { archivedAt: true },
        });
        if (!branch) throw notFound("Branch");
        if (branch.archivedAt)
          throw businessRuleViolation(
            "BRANCH_ARCHIVED",
            "Cannot add a warehouse to an archived branch",
          );
        const warehouse = await tx.warehouse.create({
          data: {
            ...input,
            organizationId: ctx.organizationId,
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          },
          select: { id: true },
        });
        await recordAudit(tx, actorOf(ctx), {
          action: "warehouse.created",
          entityType: "warehouse",
          entityId: warehouse.id,
          changes: input,
        });
        return { id: warehouse.id };
      },
    );
  } catch (error) {
    codeConflict(error);
  }
}

export async function updateWarehouse(
  ctx: TenantContext,
  warehouseId: string,
  rawInput: unknown,
): Promise<void> {
  const parsed = updateWarehouseSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const before = await findVisibleWarehouse(tx, ctx, warehouseId);
      assertPermission(ctx.grants, "warehouses.manage", target(before));
      await tx.warehouse.update({
        where: { organizationId_id: { organizationId: ctx.organizationId, id: warehouseId } },
        data: { ...parsed.data, updatedByUserId: ctx.userId },
      });
      const changes = diff(before, parsed.data);
      if (Object.keys(changes).length > 0) {
        await recordAudit(tx, actorOf(ctx), {
          action: "warehouse.updated",
          entityType: "warehouse",
          entityId: warehouseId,
          changes,
        });
      }
    });
  } catch (error) {
    codeConflict(error);
  }
}

export async function setWarehouseArchived(
  ctx: TenantContext,
  warehouseId: string,
  archived: boolean,
): Promise<void> {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const warehouse = await findVisibleWarehouse(tx, ctx, warehouseId);
    assertPermission(ctx.grants, "warehouses.manage", target(warehouse));
    if (archived === (warehouse.archivedAt !== null)) return;
    if (archived) {
      const stocked = await tx.stockBalance.count({
        where: { organizationId: ctx.organizationId, warehouseId, onHandQuantity: { gt: 0 } },
      });
      if (stocked > 0)
        throw businessRuleViolation(
          "WAREHOUSE_HAS_STOCK",
          "A warehouse holding stock cannot be archived",
        );
    }
    if (!archived && warehouse.branch.archivedAt) {
      throw businessRuleViolation(
        "BRANCH_ARCHIVED",
        "Restore the branch before restoring its warehouses",
      );
    }
    await tx.warehouse.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: warehouseId } },
      data: { archivedAt: archived ? new Date() : null, updatedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "warehouse.archived" : "warehouse.restored",
      entityType: "warehouse",
      entityId: warehouseId,
    });
  });
}

// ─── Storage locations (managed through their warehouse's permission) ───

async function findManageableWarehouse(tx: Tx, ctx: TenantContext, warehouseId: string) {
  const warehouse = await findVisibleWarehouse(tx, ctx, warehouseId);
  assertPermission(ctx.grants, "warehouses.manage", target(warehouse));
  return warehouse;
}

export async function createLocation(
  ctx: TenantContext,
  warehouseId: string,
  rawInput: unknown,
): Promise<{ id: string }> {
  const parsed = createLocationSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  try {
    return await runIdempotent(
      ctx,
      { key: idempotencyKey, operation: "location.create", input: { warehouseId, ...input } },
      async (tx) => {
        const warehouse = await findManageableWarehouse(tx, ctx, warehouseId);
        if (warehouse.archivedAt)
          throw businessRuleViolation(
            "WAREHOUSE_ARCHIVED",
            "Cannot add a location to an archived warehouse",
          );
        const location = await tx.storageLocation.create({
          data: {
            ...input,
            organizationId: ctx.organizationId,
            warehouseId,
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          },
          select: { id: true },
        });
        await recordAudit(tx, actorOf(ctx), {
          action: "location.created",
          entityType: "storage_location",
          entityId: location.id,
          changes: { warehouseId, ...input },
        });
        return { id: location.id };
      },
    );
  } catch (error) {
    codeConflict(error);
  }
}

async function findLocation(tx: Tx, ctx: TenantContext, locationId: string) {
  const location = await tx.storageLocation.findFirst({
    where: { organizationId: ctx.organizationId, id: locationId },
    select: {
      id: true,
      warehouseId: true,
      code: true,
      name: true,
      temperatureZone: true,
      archivedAt: true,
    },
  });
  if (!location) throw notFound("Storage location");
  const warehouse = await findManageableWarehouse(tx, ctx, location.warehouseId).catch((error) => {
    // Hide locations of warehouses the user cannot see.
    if ((error as { code?: string }).code === "NOT_FOUND") throw notFound("Storage location");
    throw error;
  });
  return { location, warehouse };
}

export async function updateLocation(
  ctx: TenantContext,
  locationId: string,
  rawInput: unknown,
): Promise<void> {
  const parsed = locationSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const { location } = await findLocation(tx, ctx, locationId);
      await tx.storageLocation.update({
        where: { organizationId_id: { organizationId: ctx.organizationId, id: locationId } },
        data: { ...parsed.data, updatedByUserId: ctx.userId },
      });
      const changes = diff(location, parsed.data);
      if (Object.keys(changes).length > 0) {
        await recordAudit(tx, actorOf(ctx), {
          action: "location.updated",
          entityType: "storage_location",
          entityId: locationId,
          changes,
        });
      }
    });
  } catch (error) {
    codeConflict(error);
  }
}

export async function setLocationArchived(
  ctx: TenantContext,
  locationId: string,
  archived: boolean,
): Promise<void> {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { location, warehouse } = await findLocation(tx, ctx, locationId);
    if (archived === (location.archivedAt !== null)) return;
    if (archived) {
      const stocked = await tx.stockBalance.count({
        where: { organizationId: ctx.organizationId, locationId, onHandQuantity: { gt: 0 } },
      });
      if (stocked > 0)
        throw businessRuleViolation(
          "LOCATION_HAS_STOCK",
          "A location holding stock cannot be archived",
        );
    }
    if (!archived && warehouse.archivedAt) {
      throw businessRuleViolation(
        "WAREHOUSE_ARCHIVED",
        "Restore the warehouse before restoring its locations",
      );
    }
    await tx.storageLocation.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: locationId } },
      data: { archivedAt: archived ? new Date() : null, updatedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "location.archived" : "location.restored",
      entityType: "storage_location",
      entityId: locationId,
    });
  });
}

/** Active warehouses visible to the user (for pickers). */
export async function listWarehouseOptions(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.warehouse.findMany({
      where: {
        AND: [
          { organizationId: ctx.organizationId, archivedAt: null },
          visibleWarehouseFilter(ctx),
        ],
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  );
}
