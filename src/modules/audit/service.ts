import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { assertPermission } from "@/modules/access/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { redact } from "@/server/logger";

export interface AuditActor {
  organizationId: string;
  userId: string | null;
  requestId?: string;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string;
  changes?: Record<string, unknown>;
}

/**
 * Write an audit event inside the caller's transaction, so the event exists
 * if and only if the change it describes was committed.
 */
export async function recordAudit(tx: Tx, actor: AuditActor, entry: AuditEntry): Promise<void> {
  await tx.auditEvent.create({
    data: {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      requestId: actor.requestId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      changes: entry.changes ? (redact(entry.changes) as Prisma.InputJsonValue) : undefined,
    },
  });
}

export function actorOf(ctx: TenantContext): AuditActor {
  return { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId };
}

/** Field-level diff of the keys in `next`, for audit `changes`. */
export function diff<T extends Record<string, unknown>>(
  before: T,
  next: Partial<T>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    const from = before[key] instanceof Date ? (before[key] as Date).toISOString() : before[key];
    const to = next[key] instanceof Date ? (next[key] as Date).toISOString() : next[key];
    if (from !== to) out[key as string] = { from: from ?? null, to: to ?? null };
  }
  return out;
}

export const AUDIT_PAGE_SIZE = 50;

export async function listAuditEvents(
  ctx: TenantContext,
  options: { page?: number; entityType?: string } = {},
) {
  assertPermission(ctx.grants, "audit.view");
  const page = Math.max(1, options.page ?? 1);
  const where = {
    organizationId: ctx.organizationId,
    ...(options.entityType ? { entityType: options.entityType } : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, events] = await inSequence([
      tx.auditEvent.count({ where }),
      tx.auditEvent.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        skip: (page - 1) * AUDIT_PAGE_SIZE,
        take: AUDIT_PAGE_SIZE,
      }),
    ]);
    const actorIds = [
      ...new Set(events.map((e) => e.actorUserId).filter((id): id is string => !!id)),
    ];
    const actors = await tx.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(actors.map((a) => [a.id, a.name]));
    return {
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)),
      events: events.map((e) => ({
        ...e,
        actorName: e.actorUserId ? (nameById.get(e.actorUserId) ?? null) : null,
      })),
    };
  });
}
