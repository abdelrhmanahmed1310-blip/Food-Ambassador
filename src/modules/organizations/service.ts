import "server-only";
import { accessibleScope, assertPermission, hasPermission } from "@/modules/access/authorize";
import { OWNER_ROLE_KEY, SYSTEM_ROLE_TEMPLATES } from "@/modules/access/permissions";
import { actorOf, diff, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { validationFailed } from "@/server/errors";
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  type CreateOrganizationInput,
  type UpdateOrganizationInput,
} from "./schemas";
import { slugify, withRandomSuffix } from "./slug";

async function availableSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name);
  if (!(await tx.organization.findUnique({ where: { slug: base }, select: { id: true } })))
    return base;
  for (let i = 0; i < 8; i++) {
    const candidate = withRandomSuffix(base);
    if (!(await tx.organization.findUnique({ where: { slug: candidate }, select: { id: true } })))
      return candidate;
  }
  throw new Error("Could not allocate a unique organization slug");
}

/**
 * Create an organization with its system roles and make `userId` its Owner
 * (DECISIONS.md A-03). System operation: the tenant does not exist yet.
 */
export async function createOrganization(
  userId: string,
  rawInput: CreateOrganizationInput,
  requestId?: string,
): Promise<{ id: string; slug: string }> {
  const parsed = createOrganizationSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;

  for (let attempt = 0; ; attempt++) {
    try {
      return await withSystemTx(async (tx) => {
        const slug = await availableSlug(tx, input.name);
        const org = await tx.organization.create({
          data: { ...input, slug, createdByUserId: userId },
          select: { id: true, slug: true },
        });
        let ownerRoleId = "";
        for (const template of SYSTEM_ROLE_TEMPLATES) {
          const role = await tx.role.create({
            data: {
              organizationId: org.id,
              key: template.key,
              name: template.name,
              description: template.description,
              isSystem: true,
              permissions: {
                create: template.permissions.map((permission) => ({ permission })),
              },
            },
            select: { id: true },
          });
          if (template.key === OWNER_ROLE_KEY) ownerRoleId = role.id;
        }
        const membership = await tx.organizationMembership.create({
          data: { organizationId: org.id, userId },
          select: { id: true },
        });
        await tx.membershipRole.create({
          data: {
            organizationId: org.id,
            membershipId: membership.id,
            roleId: ownerRoleId,
            scopeType: "ORGANIZATION",
          },
        });
        await recordAudit(
          tx,
          { organizationId: org.id, userId, requestId },
          {
            action: "organization.created",
            entityType: "organization",
            entityId: org.id,
            changes: { ...input, slug },
          },
        );
        return org;
      });
    } catch (error) {
      // Two sign-ups racing for the same slug: retry with a fresh suffix.
      if (attempt < 3 && isUniqueViolation(error, "organizations_slug_key")) continue;
      throw error;
    }
  }
}

export interface OrganizationSummary {
  id: string;
  slug: string;
  name: string;
}

/** Organizations where the user has an active membership (for the switcher and post-sign-in redirect). */
export async function listUserOrganizations(userId: string): Promise<OrganizationSummary[]> {
  return withSystemTx((tx) =>
    tx.organization.findMany({
      where: { status: "ACTIVE", memberships: { some: { userId, status: "ACTIVE" } } },
      select: { id: true, slug: true, name: true },
      orderBy: { name: "asc" },
    }),
  );
}

export async function getOrganizationSettings(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        baseCurrency: true,
        timeZone: true,
        defaultLocale: true,
      },
    }),
  );
}

export async function updateOrganization(
  ctx: TenantContext,
  rawInput: UpdateOrganizationInput,
): Promise<void> {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = updateOrganizationSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const before = await tx.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: { name: true, timeZone: true, defaultLocale: true },
    });
    await tx.organization.update({ where: { id: ctx.organizationId }, data: parsed.data });
    const changes = diff(before, parsed.data);
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, actorOf(ctx), {
        action: "organization.updated",
        entityType: "organization",
        entityId: ctx.organizationId,
        changes,
      });
    }
  });
}

/** Real counts for the overview page, limited to what the user may see. */
export async function getOverview(ctx: TenantContext) {
  const branchScope = accessibleScope(ctx.grants, "branches.view");
  const whScope = accessibleScope(ctx.grants, "warehouses.view");
  const whFilter = whScope.all
    ? {}
    : { OR: [{ branchId: { in: whScope.branchIds } }, { id: { in: whScope.warehouseIds } }] };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [branches, warehouses, locations, members] = await inSequence([
      tx.branch.count({
        where: {
          organizationId: ctx.organizationId,
          archivedAt: null,
          ...(branchScope.all ? {} : { id: { in: branchScope.branchIds } }),
        },
      }),
      tx.warehouse.count({
        where: { organizationId: ctx.organizationId, archivedAt: null, ...whFilter },
      }),
      tx.storageLocation.count({
        where: { organizationId: ctx.organizationId, archivedAt: null, warehouse: whFilter },
      }),
      hasPermission(ctx.grants, "members.view")
        ? tx.organizationMembership.count({
            where: { organizationId: ctx.organizationId, status: "ACTIVE" },
          })
        : Promise.resolve(null),
    ]);
    return { branches, warehouses, locations, members };
  });
}
