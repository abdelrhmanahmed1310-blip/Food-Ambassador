import { buildGrants, type Grant, type GrantScope } from "@/modules/access/authorize";
import type { Tx } from "@/server/db/transactions";

/**
 * Everything a service needs to act on behalf of a user inside one
 * organization. Built only on the server from the authenticated user and their
 * active membership — never from client input.
 */
export interface TenantContext {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  baseCurrency: string;
  timeZone: string;
  userId: string;
  membershipId: string;
  grants: Grant[];
  requestId?: string;
}

function toScope(row: {
  scopeType: string;
  branchId: string | null;
  warehouseId: string | null;
}): GrantScope {
  if (row.scopeType === "BRANCH" && row.branchId) return { type: "BRANCH", branchId: row.branchId };
  if (row.scopeType === "WAREHOUSE" && row.warehouseId)
    return { type: "WAREHOUSE", warehouseId: row.warehouseId };
  return { type: "ORGANIZATION" };
}

/**
 * Resolve the context for `userId` in the organization identified by `slug`.
 * Returns null (callers respond 404) unless the organization is active, the
 * user is active, and the user holds an active membership in it.
 * Runs in a system transaction: tenant identity is not yet established.
 */
export async function resolveTenantContext(
  tx: Tx,
  userId: string,
  slug: string,
  requestId?: string,
): Promise<TenantContext | null> {
  const membership = await tx.organizationMembership.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      user: { status: "ACTIVE" },
      organization: { slug, status: "ACTIVE" },
    },
    select: {
      id: true,
      organization: {
        select: { id: true, slug: true, name: true, baseCurrency: true, timeZone: true },
      },
      roles: {
        select: {
          scopeType: true,
          branchId: true,
          warehouseId: true,
          role: { select: { key: true, permissions: { select: { permission: true } } } },
        },
      },
    },
  });
  if (!membership) return null;

  const grants = buildGrants(
    membership.roles.map((r) => ({
      roleKey: r.role.key,
      permissions: r.role.permissions.map((p) => p.permission),
      scope: toScope(r),
    })),
  );
  const org = membership.organization;
  return {
    organizationId: org.id,
    organizationSlug: org.slug,
    organizationName: org.name,
    baseCurrency: org.baseCurrency,
    timeZone: org.timeZone,
    userId,
    membershipId: membership.id,
    grants,
    requestId,
  };
}
