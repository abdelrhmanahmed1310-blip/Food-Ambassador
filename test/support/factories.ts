import { uuidv7 } from "@/lib/uuid";
import { createOrganization } from "@/modules/organizations/service";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withSystemTx } from "@/server/db/transactions";

export function uniqueEmail(label = "user"): string {
  return `${label}-${uuidv7().slice(-12)}@example.test`;
}

export async function createUser(label = "user") {
  return getDb().user.create({ data: { name: `Test ${label}`, email: uniqueEmail(label) } });
}

export async function contextFor(userId: string, slug: string): Promise<TenantContext> {
  const ctx = await withSystemTx((tx) => resolveTenantContext(tx, userId, slug));
  if (!ctx) throw new Error(`User ${userId} has no access to ${slug}`);
  return ctx;
}

/** A fresh organization with its owner, as created by sign-up. */
export async function createTenant(label = "org") {
  const owner = await createUser(`${label}-owner`);
  const org = await createOrganization(owner.id, {
    name: `Tenant ${label} ${uuidv7().slice(-6)}`,
    baseCurrency: "EGP",
    timeZone: "Africa/Cairo",
  });
  const ctx = await contextFor(owner.id, org.slug);
  return { owner, org, ctx };
}

/** Add an existing user to an organization with a system role (optionally scoped). */
export async function addMember(
  ctx: TenantContext,
  roleKey: string,
  scope: {
    scopeType?: "ORGANIZATION" | "BRANCH" | "WAREHOUSE";
    branchId?: string;
    warehouseId?: string;
  } = {},
  label = roleKey,
) {
  const user = await createUser(label);
  const db = getDb();
  const role = await db.role.findUniqueOrThrow({
    where: { organizationId_key: { organizationId: ctx.organizationId, key: roleKey } },
  });
  const membership = await db.organizationMembership.create({
    data: { organizationId: ctx.organizationId, userId: user.id },
  });
  await db.membershipRole.create({
    data: {
      organizationId: ctx.organizationId,
      membershipId: membership.id,
      roleId: role.id,
      scopeType: scope.scopeType ?? "ORGANIZATION",
      branchId: scope.branchId,
      warehouseId: scope.warehouseId,
    },
  });
  return { user, membership, ctx: await contextFor(user.id, ctx.organizationSlug) };
}

export async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const actual = (error as { code?: string }).code;
    if (actual !== code)
      throw new Error(`Expected AppError ${code} but got ${actual}: ${(error as Error).message}`);
    return;
  }
  throw new Error(`Expected AppError ${code} but the call succeeded`);
}
