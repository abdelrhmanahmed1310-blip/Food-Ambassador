import "server-only";
import { z } from "zod";
import { buildGrants, type Grant } from "@/modules/access/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { notFound, validationFailed } from "@/server/errors";

/**
 * In-app notifications (DECISIONS.md ADR-087). A notification is written in
 * the same transaction as the change it reports, so it exists exactly when
 * the change does. Recipients are worked out from their roles and scopes
 * (the same grants that let them act), never the person who acted. Each
 * user can turn a kind off. No email, SMS or WhatsApp is sent: no provider
 * is chosen yet (decision D2).
 */

export const NOTIFICATION_KINDS = [
  "PO_APPROVAL_NEEDED",
  "PO_APPROVED",
  "PO_REJECTED",
  "COUNT_APPROVAL_NEEDED",
  "COUNT_DECIDED",
  "LEAVE_REQUESTED",
  "LEAVE_DECIDED",
  "INVOICE_EXCEPTION",
  "SUPPLIER_APPROVAL_NEEDED",
  "SUPPLIER_BANK_ACCOUNT_ADDED",
  "ATTENTION_DIGEST",
  "JOB_FAILED",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NewNotification {
  kind: NotificationKind;
  /** Values for the message (document numbers, counts); never secrets or personal data. */
  params?: Record<string, string | number>;
  entityType?: string;
  entityId?: string;
  /** Path below /o/<slug>. */
  link?: string;
  /** At most one notification per user and key (e.g. a daily digest). */
  dedupeKey?: string;
}

/** Active members of the organization with their grants (roles and scopes). */
export async function membersWithGrantsInTx(tx: Tx, organizationId: string) {
  const memberships = await tx.organizationMembership.findMany({
    where: { organizationId, status: "ACTIVE", user: { status: "ACTIVE" } },
    select: {
      userId: true,
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
  return memberships.map((m) => ({
    userId: m.userId,
    grants: buildGrants(
      m.roles.map((r) => ({
        roleKey: r.role.key,
        permissions: r.role.permissions.map((p) => p.permission),
        scope:
          r.scopeType === "BRANCH" && r.branchId
            ? { type: "BRANCH" as const, branchId: r.branchId }
            : r.scopeType === "WAREHOUSE" && r.warehouseId
              ? { type: "WAREHOUSE" as const, warehouseId: r.warehouseId }
              : { type: "ORGANIZATION" as const },
      })),
    ),
  }));
}

/** The members whose grants pass `test`, except `exclude` (the person who acted). */
export async function recipientsInTx(
  tx: Tx,
  ctx: TenantContext,
  test: (grants: readonly Grant[]) => boolean,
  exclude: Array<string | null | undefined> = [ctx.userId],
) {
  const skip = new Set(exclude.filter(Boolean));
  return (await membersWithGrantsInTx(tx, ctx.organizationId))
    .filter((m) => !skip.has(m.userId) && test(m.grants))
    .map((m) => m.userId);
}

/**
 * Write a notification for each recipient who has not turned the kind off;
 * a repeated dedupe key is ignored. Returns how many were written.
 */
export async function notifyInTx(
  tx: Tx,
  organizationId: string,
  userIds: readonly string[],
  n: NewNotification,
) {
  const users = [...new Set(userIds)];
  if (users.length === 0) return 0;
  const off = new Set(
    (
      await tx.notificationPreference.findMany({
        where: { organizationId, userId: { in: users }, kind: n.kind, inApp: false },
        select: { userId: true },
      })
    ).map((p) => p.userId),
  );
  const to = users.filter((u) => !off.has(u));
  if (to.length === 0) return 0;
  const written = await tx.notification.createMany({
    data: to.map((userId) => ({
      organizationId,
      userId,
      kind: n.kind,
      params: n.params ?? {},
      entityType: n.entityType ?? null,
      entityId: n.entityId ?? null,
      link: n.link ?? null,
      dedupeKey: n.dedupeKey ?? null,
    })),
    skipDuplicates: true,
  });
  return written.count;
}

// ─── The user's own notifications ───

const PAGE = 30;

export async function listNotifications(
  ctx: TenantContext,
  options: { unreadOnly?: boolean; page?: number } = {},
) {
  const page = Math.max(1, options.page ?? 1);
  const where = {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    ...(options.unreadOnly ? { readAt: null } : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [items, total, unread] = await inSequence([
      tx.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE,
        take: PAGE,
      }),
      tx.notification.count({ where }),
      tx.notification.count({
        where: { organizationId: ctx.organizationId, userId: ctx.userId, readAt: null },
      }),
    ]);
    return { items, unread, page, pageCount: Math.max(1, Math.ceil(total / PAGE)) };
  });
}

export async function unreadCount(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.notification.count({
      where: { organizationId: ctx.organizationId, userId: ctx.userId, readAt: null },
    }),
  );
}

/** Mark one of the user's own notifications read; returns its link to open. */
export async function markNotificationRead(ctx: TenantContext, id: string) {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw notFound("Notification");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const n = await tx.notification.findFirst({
      where: { organizationId: ctx.organizationId, userId: ctx.userId, id: parsed.data },
      select: { id: true, link: true, readAt: true },
    });
    if (!n) throw notFound("Notification");
    if (!n.readAt)
      await tx.notification.update({ where: { id: n.id }, data: { readAt: new Date() } });
    return { link: n.link };
  });
}

export async function markAllNotificationsRead(ctx: TenantContext) {
  return withTenantTx(
    ctx.organizationId,
    async (tx) =>
      (
        await tx.notification.updateMany({
          where: { organizationId: ctx.organizationId, userId: ctx.userId, readAt: null },
          data: { readAt: new Date() },
        })
      ).count,
  );
}

// ─── Preferences ───

export async function notificationPreferences(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.notificationPreference.findMany({
      where: { organizationId: ctx.organizationId, userId: ctx.userId },
    });
    const off = new Set(rows.filter((r) => !r.inApp).map((r) => r.kind));
    return NOTIFICATION_KINDS.map((kind) => ({ kind, inApp: !off.has(kind) }));
  });
}

const preferencesSchema = z.object({
  /** The kinds kept on; every other kind is turned off. */
  on: z.array(z.enum(NOTIFICATION_KINDS, { error: "invalidOption" })).default([]),
});

export async function saveNotificationPreferences(ctx: TenantContext, rawInput: unknown) {
  const parsed = preferencesSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const on = new Set(parsed.data.on);
  await withTenantTx(ctx.organizationId, async (tx) => {
    for (const kind of NOTIFICATION_KINDS) {
      const key = { organizationId: ctx.organizationId, userId: ctx.userId, kind };
      if (on.has(kind))
        await tx.notificationPreference.deleteMany({ where: key }); // default is on
      else
        await tx.notificationPreference.upsert({
          where: { organizationId_userId_kind: key },
          create: { ...key, inApp: false },
          update: { inApp: false },
        });
    }
  });
}
