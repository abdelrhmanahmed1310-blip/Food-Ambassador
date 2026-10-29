import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { assertPermission, isOwner } from "@/modules/access/authorize";
import { OWNER_ROLE_KEY, isOrganizationScopeOnlyRole } from "@/modules/access/permissions";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import { inviteSchema, roleScopeSchema } from "./schemas";

export const INVITATION_TTL_DAYS = 7;

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ─── Queries ───

export async function listMembers(ctx: TenantContext) {
  assertPermission(ctx.grants, "members.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [members, invitations] = await inSequence([
      tx.organizationMembership.findMany({
        where: { organizationId: ctx.organizationId, status: "ACTIVE" },
        select: {
          id: true,
          joinedAt: true,
          user: { select: { id: true, name: true, email: true } },
          roles: {
            select: {
              id: true,
              scopeType: true,
              role: { select: { id: true, key: true, name: true } },
              branch: { select: { id: true, code: true, name: true } },
              warehouse: { select: { id: true, code: true, name: true } },
            },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: { joinedAt: "asc" },
      }),
      tx.invitation.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: "PENDING",
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          email: true,
          scopeType: true,
          expiresAt: true,
          role: { select: { key: true, name: true } },
          branch: { select: { code: true, name: true } },
          warehouse: { select: { code: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return { members, invitations };
  });
}

// ─── Scope validation shared by invitations and grants ───

type RoleScope = ReturnType<typeof roleScopeSchema.parse>;

async function validateRoleScope(tx: Tx, ctx: TenantContext, scope: RoleScope) {
  const role = await tx.role.findFirst({
    where: { organizationId: ctx.organizationId, id: scope.roleId },
    select: { id: true, key: true },
  });
  if (!role) throw notFound("Role");
  // Only owners can hand out ownership.
  if (role.key === OWNER_ROLE_KEY && !isOwner(ctx.grants))
    throw forbidden("Only an owner can grant the Owner role");
  if (scope.scopeType !== "ORGANIZATION" && isOrganizationScopeOnlyRole(role.key)) {
    throw businessRuleViolation(
      "ROLE_ORGANIZATION_SCOPE_ONLY",
      "This role can only be granted organization-wide",
    );
  }
  if (scope.branchId) {
    const branch = await tx.branch.findFirst({
      where: { organizationId: ctx.organizationId, id: scope.branchId },
      select: { id: true },
    });
    if (!branch) throw notFound("Branch");
  }
  if (scope.warehouseId) {
    const wh = await tx.warehouse.findFirst({
      where: { organizationId: ctx.organizationId, id: scope.warehouseId },
      select: { id: true },
    });
    if (!wh) throw notFound("Warehouse");
  }
  return role;
}

/**
 * Lock the organization row, then count active owners other than `excludingMembershipId`
 * (or excluding one specific owner grant). The lock serializes concurrent removals
 * so two admins cannot each remove "the other" last owner.
 */
async function assertOwnerRemains(
  tx: Tx,
  ctx: TenantContext,
  exclude: { membershipId?: string; grantId?: string },
) {
  await tx.$queryRaw`SELECT 1 FROM "organizations" WHERE "id" = ${ctx.organizationId}::uuid FOR UPDATE`;
  const remaining = await tx.membershipRole.count({
    where: {
      organizationId: ctx.organizationId,
      role: { key: OWNER_ROLE_KEY },
      membership: { status: "ACTIVE" },
      ...(exclude.membershipId ? { membershipId: { not: exclude.membershipId } } : {}),
      ...(exclude.grantId ? { id: { not: exclude.grantId } } : {}),
    },
  });
  if (remaining === 0)
    throw businessRuleViolation("LAST_OWNER", "An organization must keep at least one owner");
}

// ─── Invitations ───

export async function createInvitation(
  ctx: TenantContext,
  rawInput: unknown,
): Promise<{ invitationId: string; token: string }> {
  assertPermission(ctx.grants, "members.manage");
  const parsed = inviteSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { email, ...scope } = parsed.data;
  const token = randomBytes(32).toString("base64url");
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      await validateRoleScope(tx, ctx, scope);
      const existingMember = await tx.organizationMembership.findFirst({
        where: { organizationId: ctx.organizationId, status: "ACTIVE", user: { email } },
        select: { id: true },
      });
      if (existingMember)
        throw conflict("This person is already a member", {
          reason: "alreadyMember",
          field: "email",
        });
      // Expired pending invitations would block the partial unique index; retire them.
      await tx.invitation.updateMany({
        where: {
          organizationId: ctx.organizationId,
          email,
          status: "PENDING",
          expiresAt: { lte: new Date() },
        },
        data: { status: "REVOKED" },
      });
      const invitation = await tx.invitation.create({
        data: {
          organizationId: ctx.organizationId,
          email,
          ...scope,
          tokenHash: hashInvitationToken(token),
          expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
          invitedByUserId: ctx.userId,
        },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "invitation.created",
        entityType: "invitation",
        entityId: invitation.id,
        changes: { email, ...scope },
      });
      return { invitationId: invitation.id, token };
    });
  } catch (error) {
    if (isUniqueViolation(error, "invitations_pending_email_key")) {
      throw conflict("An invitation is already pending for this email", {
        reason: "invitationPending",
        field: "email",
      });
    }
    throw error;
  }
}

export async function revokeInvitation(ctx: TenantContext, invitationId: string): Promise<void> {
  assertPermission(ctx.grants, "members.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { count } = await tx.invitation.updateMany({
      where: { organizationId: ctx.organizationId, id: invitationId, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    if (count === 0) throw notFound("Invitation");
    await recordAudit(tx, actorOf(ctx), {
      action: "invitation.revoked",
      entityType: "invitation",
      entityId: invitationId,
    });
  });
}

export interface InvitationPreview {
  organizationName: string;
  email: string;
  roleName: string;
  roleKey: string;
  valid: boolean;
}

/** Public preview for the invitation page; reveals only what the link holder needs. */
export async function previewInvitation(token: string): Promise<InvitationPreview | null> {
  const invitation = await withSystemTx((tx) =>
    tx.invitation.findUnique({
      where: { tokenHash: hashInvitationToken(token) },
      select: {
        email: true,
        status: true,
        expiresAt: true,
        organization: { select: { name: true, status: true } },
        role: { select: { name: true, key: true } },
      },
    }),
  );
  if (!invitation) return null;
  return {
    organizationName: invitation.organization.name,
    email: invitation.email,
    roleName: invitation.role.name,
    roleKey: invitation.role.key,
    valid:
      invitation.status === "PENDING" &&
      invitation.expiresAt > new Date() &&
      invitation.organization.status === "ACTIVE",
  };
}

/**
 * Accept an invitation as the signed-in user. System operation (the user is
 * not yet a member). The invitation must be pending, unexpired and addressed
 * to the user's email; the conditional status update makes acceptance single-use.
 */
export async function acceptInvitation(
  user: { id: string; email: string },
  token: string,
  requestId?: string,
): Promise<{ organizationSlug: string }> {
  return withSystemTx(async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { tokenHash: hashInvitationToken(token) },
      select: {
        id: true,
        organizationId: true,
        email: true,
        status: true,
        expiresAt: true,
        roleId: true,
        scopeType: true,
        branchId: true,
        warehouseId: true,
        organization: { select: { slug: true, status: true } },
      },
    });
    if (!invitation || invitation.organization.status !== "ACTIVE") throw notFound("Invitation");
    if (invitation.status !== "PENDING" || invitation.expiresAt <= new Date()) {
      throw businessRuleViolation("INVITATION_NOT_PENDING", "This invitation is no longer valid");
    }
    if (invitation.email !== user.email.toLowerCase()) {
      throw forbidden("This invitation was sent to a different email address");
    }
    const claimed = await tx.invitation.updateMany({
      where: { id: invitation.id, status: "PENDING" },
      data: { status: "ACCEPTED", acceptedByUserId: user.id, acceptedAt: new Date() },
    });
    if (claimed.count === 0)
      throw businessRuleViolation("INVITATION_NOT_PENDING", "This invitation is no longer valid");

    const membership = await tx.organizationMembership.upsert({
      where: {
        organizationId_userId: { organizationId: invitation.organizationId, userId: user.id },
      },
      create: { organizationId: invitation.organizationId, userId: user.id, invitedByUserId: null },
      update: { status: "ACTIVE", removedAt: null, joinedAt: new Date() },
      select: { id: true },
    });
    const grant: Prisma.MembershipRoleUncheckedCreateInput = {
      organizationId: invitation.organizationId,
      membershipId: membership.id,
      roleId: invitation.roleId,
      scopeType: invitation.scopeType,
      branchId: invitation.branchId,
      warehouseId: invitation.warehouseId,
    };
    const existingGrant = await tx.membershipRole.findFirst({ where: grant, select: { id: true } });
    if (!existingGrant) await tx.membershipRole.create({ data: grant });
    await recordAudit(
      tx,
      { organizationId: invitation.organizationId, userId: user.id, requestId },
      {
        action: "invitation.accepted",
        entityType: "membership",
        entityId: membership.id,
        changes: { invitationId: invitation.id },
      },
    );
    return { organizationSlug: invitation.organization.slug };
  });
}

// ─── Role grants and removal ───

async function findActiveMembership(tx: Tx, ctx: TenantContext, membershipId: string) {
  const membership = await tx.organizationMembership.findFirst({
    where: { organizationId: ctx.organizationId, id: membershipId, status: "ACTIVE" },
    select: {
      id: true,
      userId: true,
      roles: { select: { id: true, role: { select: { key: true } } } },
    },
  });
  if (!membership) throw notFound("Member");
  return membership;
}

export async function grantRole(
  ctx: TenantContext,
  membershipId: string,
  rawInput: unknown,
): Promise<void> {
  assertPermission(ctx.grants, "members.manage");
  const parsed = roleScopeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      await findActiveMembership(tx, ctx, membershipId);
      await validateRoleScope(tx, ctx, parsed.data);
      const grant = await tx.membershipRole.create({
        data: { organizationId: ctx.organizationId, membershipId, ...parsed.data },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "member.role_granted",
        entityType: "membership",
        entityId: membershipId,
        changes: { grantId: grant.id, ...parsed.data },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "membership_roles_grant_key"))
      throw conflict("The member already has this role", { reason: "alreadyGranted" });
    throw error;
  }
}

export async function revokeRole(
  ctx: TenantContext,
  membershipId: string,
  grantId: string,
): Promise<void> {
  assertPermission(ctx.grants, "members.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const membership = await findActiveMembership(tx, ctx, membershipId);
    const grant = membership.roles.find((r) => r.id === grantId);
    if (!grant) throw notFound("Role assignment");
    if (grant.role.key === OWNER_ROLE_KEY) {
      if (!isOwner(ctx.grants)) throw forbidden("Only an owner can revoke the Owner role");
      await assertOwnerRemains(tx, ctx, { grantId });
    }
    await tx.membershipRole.delete({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: grantId } },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "member.role_revoked",
      entityType: "membership",
      entityId: membershipId,
      changes: { grantId, roleKey: grant.role.key },
    });
  });
}

export async function removeMember(ctx: TenantContext, membershipId: string): Promise<void> {
  assertPermission(ctx.grants, "members.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const membership = await findActiveMembership(tx, ctx, membershipId);
    if (membership.id === ctx.membershipId)
      throw businessRuleViolation("CANNOT_REMOVE_SELF", "You cannot remove yourself");
    if (membership.roles.some((r) => r.role.key === OWNER_ROLE_KEY)) {
      if (!isOwner(ctx.grants)) throw forbidden("Only an owner can remove another owner");
      await assertOwnerRemains(tx, ctx, { membershipId });
    }
    await tx.membershipRole.deleteMany({
      where: { organizationId: ctx.organizationId, membershipId },
    });
    await tx.organizationMembership.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: membershipId } },
      data: { status: "REMOVED", removedAt: new Date() },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "member.removed",
      entityType: "membership",
      entityId: membershipId,
    });
  });
}
