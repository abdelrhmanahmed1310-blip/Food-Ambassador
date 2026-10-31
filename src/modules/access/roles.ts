import "server-only";
import { z } from "zod";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { OWNER_ROLE_KEY, PERMISSIONS, type Permission } from "@/modules/access/permissions";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { requiredText, optionalText } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import { uuidv7 } from "@/lib/uuid";

const permissionListSchema = z
  .array(z.enum(PERMISSIONS, { error: "invalidOption" }))
  .transform((list) => [...new Set(list)]);

export const roleSchema = z.object({
  name: requiredText(80),
  description: optionalText(300),
  permissions: permissionListSchema,
});

export async function listRoles(ctx: TenantContext) {
  // Role pickers on the members pages and the roles page itself.
  const allowed: Permission[] = ["members.view", "members.manage", "roles.manage"];
  if (!allowed.some((p) => hasPermission(ctx.grants, p))) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const roles = await tx.role.findMany({
      where: { organizationId: ctx.organizationId },
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        isSystem: true,
        permissions: { select: { permission: true } },
        _count: { select: { membershipRoles: true } },
      },
      orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }],
    });
    return roles.map((r) => ({
      ...r,
      // Owner always holds every permission (stored rows are not authoritative for it).
      permissions:
        r.key === OWNER_ROLE_KEY
          ? [...PERMISSIONS]
          : (r.permissions.map((p) => p.permission) as Permission[]),
      editable: r.key !== OWNER_ROLE_KEY,
    }));
  });
}

export async function getRole(ctx: TenantContext, roleId: string) {
  const roles = await listRoles(ctx);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw notFound("Role");
  return role;
}

export async function createRole(ctx: TenantContext, rawInput: unknown): Promise<{ id: string }> {
  assertPermission(ctx.grants, "roles.manage");
  const parsed = roleSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { permissions, ...input } = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const role = await tx.role.create({
        data: {
          ...input,
          organizationId: ctx.organizationId,
          key: `custom_${uuidv7().replaceAll("-", "").slice(-12)}`,
          isSystem: false,
          permissions: { create: permissions.map((permission) => ({ permission })) },
        },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "role.created",
        entityType: "role",
        entityId: role.id,
        changes: { ...input, permissions },
      });
      return role;
    });
  } catch (error) {
    if (isUniqueViolation(error, "roles_organization_id_key_key"))
      throw conflict("Role already exists");
    throw error;
  }
}

export async function updateRole(
  ctx: TenantContext,
  roleId: string,
  rawInput: unknown,
): Promise<void> {
  assertPermission(ctx.grants, "roles.manage");
  const parsed = roleSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { permissions, ...input } = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const role = await tx.role.findFirst({
      where: { organizationId: ctx.organizationId, id: roleId },
      select: { key: true, name: true, permissions: { select: { permission: true } } },
    });
    if (!role) throw notFound("Role");
    if (role.key === OWNER_ROLE_KEY)
      throw businessRuleViolation("OWNER_ROLE_IMMUTABLE", "The Owner role cannot be changed");
    const before = role.permissions.map((p) => p.permission).sort();
    await tx.role.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: roleId } },
      data: input,
    });
    await tx.rolePermission.deleteMany({ where: { organizationId: ctx.organizationId, roleId } });
    await tx.rolePermission.createMany({
      data: permissions.map((permission) => ({
        organizationId: ctx.organizationId,
        roleId,
        permission,
      })),
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "role.updated",
      entityType: "role",
      entityId: roleId,
      changes: {
        name: { from: role.name, to: input.name },
        permissions: { from: before, to: [...permissions].sort() },
      },
    });
  });
}
