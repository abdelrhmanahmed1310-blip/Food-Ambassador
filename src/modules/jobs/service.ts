import { purgeOldConversations } from "@/modules/assistant/service";
import "server-only";
import { purgeCandidates } from "@/modules/recruitment/service";
import { runSyncJob, scheduleNutritionRefresh } from "@/modules/nutrition/engine/sync";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { hasPermission } from "@/modules/access/authorize";
import { attentionItems } from "@/modules/analytics/attention";
import { purgeExpiredAttachments } from "@/modules/attachments/service";
import { sendDueCampaigns } from "@/modules/crm/campaigns";
import { purgeDeliveryContacts } from "@/modules/delivery/home";
import { deliverDueWebhooks } from "@/modules/integrations/service";
import { membersWithGrantsInTx, notifyInTx } from "@/modules/notifications/service";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { assertPermission } from "@/modules/access/authorize";
import { reportDueDocuments } from "@/modules/zatca/service";
import { getDb } from "@/server/db/client";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import {
  DIGEST_HOUR,
  STALE_AFTER_MINUTES,
  jobRetryDelaySeconds,
  localDateHour,
  slotKey,
} from "./rules";

/**
 * Background jobs (DECISIONS.md ADR-087): a queue in PostgreSQL — no new
 * infrastructure. A worker (scripts/run-jobs.ts) first schedules the
 * recurring jobs, then claims due jobs one at a time (FOR UPDATE SKIP
 * LOCKED, so several workers can run side by side), runs them, and retries
 * failures with backoff. A job that keeps failing is marked FAILED and the
 * organization's administrators are told. Jobs report counts only — never
 * payloads, personal data or secrets.
 */

type Json = Prisma.InputJsonValue;
type Handler = (payload: Record<string, unknown>) => Promise<Record<string, number>>;

/** Add a job; a repeated dedupe key is ignored. Works in a tenant or a system transaction. */
export async function enqueueJobInTx(
  tx: Tx,
  job: {
    organizationId?: string | null;
    kind: JobKind;
    payload?: Record<string, unknown>;
    runAt?: Date;
    dedupeKey?: string;
    maxAttempts?: number;
  },
) {
  const created = await tx.job.createMany({
    data: [
      {
        organizationId: job.organizationId ?? null,
        kind: job.kind,
        payload: (job.payload ?? {}) as Json,
        runAt: job.runAt ?? new Date(),
        dedupeKey: job.dedupeKey ?? null,
        maxAttempts: job.maxAttempts ?? 5,
      },
    ],
    skipDuplicates: true,
  });
  return created.count;
}

// ─── Handlers ───

/** The daily "needs attention" summary for each member of one organization. */
async function attentionDigest(payload: Record<string, unknown>): Promise<Record<string, number>> {
  const organizationId = String(payload.organizationId);
  const date = String(payload.date);
  const org = await withSystemTx((tx) =>
    tx.organization.findUnique({
      where: { id: organizationId },
      select: { slug: true, status: true },
    }),
  );
  if (!org || org.status !== "ACTIVE") return { members: 0, notified: 0 };
  const members = await withTenantTx(organizationId, (tx) =>
    membersWithGrantsInTx(tx, organizationId),
  );
  let notified = 0;
  for (const m of members) {
    // The same view the user gets on the attention page: only what they may act on.
    const ctx = await withSystemTx((tx) => resolveTenantContext(tx, m.userId, org.slug));
    if (!ctx) continue;
    const items = await attentionItems(ctx);
    if (items.length === 0) continue;
    notified += await withTenantTx(organizationId, (tx) =>
      notifyInTx(tx, organizationId, [m.userId], {
        kind: "ATTENTION_DIGEST",
        params: { items: items.length, total: items.reduce((a, i) => a + i.count, 0) },
        link: "/attention",
        dedupeKey: `digest:${date}`,
      }),
    );
  }
  return { members: members.length, notified };
}

const HANDLERS = {
  "webhooks.deliver": async () => {
    const r = await deliverDueWebhooks({ limit: 100 });
    return { delivered: r.filter((x) => x.status === "DELIVERED").length, attempted: r.length };
  },
  "zatca.report": async () => {
    const r = await reportDueDocuments({ limit: 200 });
    return { attempted: r.length, pending: r.filter((x) => x.status === "PENDING").length };
  },
  "attachments.purge": async () => {
    let purged = 0;
    for (;;) {
      const r = await purgeExpiredAttachments({ limit: 500 });
      purged += r.purged;
      if (r.purged < 500) break;
    }
    return { purged };
  },
  "attention.digest": attentionDigest,
  "deliveries.purge-contacts": async () => purgeDeliveryContacts(),
  "campaigns.send": async () => sendDueCampaigns(),
  "assistant.purge": async () => purgeOldConversations(),
  "recruitment.purge": async () => purgeCandidates(),
  "nutrition.sync": (payload) => runSyncJob(payload),
  "nutrition.schedule": async () => scheduleNutritionRefresh(),
} satisfies Record<string, Handler>;
export type JobKind = keyof typeof HANDLERS;
export const JOB_KINDS = Object.keys(HANDLERS) as JobKind[];

// ─── Scheduling ───

/**
 * Add the recurring jobs that are due (idempotent through dedupe keys):
 * webhook delivery every minute, ZATCA reporting every 10 minutes, the
 * attachment purge daily, and each organization's attention digest once a
 * day after 06:00 in its time zone.
 */
export async function scheduleRecurringJobs(now = new Date()) {
  return withSystemTx(async (tx) => {
    let added = 0;
    added += await enqueueJobInTx(tx, {
      kind: "webhooks.deliver",
      dedupeKey: `webhooks.deliver:${slotKey(now, 1)}`,
      maxAttempts: 1,
    });
    // Campaign messages that are due (ADR-119).
    added += await enqueueJobInTx(tx, {
      kind: "campaigns.send",
      dedupeKey: `campaigns.send:${slotKey(now, 1)}`,
      maxAttempts: 1,
    });
    added += await enqueueJobInTx(tx, {
      kind: "zatca.report",
      dedupeKey: `zatca.report:${slotKey(now, 10)}`,
      maxAttempts: 1,
    });
    added += await enqueueJobInTx(tx, {
      kind: "attachments.purge",
      dedupeKey: `attachments.purge:${now.toISOString().slice(0, 10)}`,
    });
    // Assistant conversations untouched for 90 days (ADR-122).
    added += await enqueueJobInTx(tx, {
      kind: "assistant.purge",
      dedupeKey: `assistant.purge:${now.toISOString().slice(0, 10)}`,
    });
    // Nightly USDA refresh for organizations that switched it on (ADR-132).
    added += await enqueueJobInTx(tx, {
      kind: "nutrition.schedule",
      dedupeKey: `nutrition.schedule:${now.toISOString().slice(0, 10)}`,
    });
    // Candidates past the organization's retention days (ADR-129).
    added += await enqueueJobInTx(tx, {
      kind: "recruitment.purge",
      dedupeKey: `recruitment.purge:${now.toISOString().slice(0, 10)}`,
    });
    // Customer contact details of own deliveries, 30 days after they end (ADR-117).
    added += await enqueueJobInTx(tx, {
      kind: "deliveries.purge-contacts",
      dedupeKey: `deliveries.purge-contacts:${now.toISOString().slice(0, 10)}`,
    });
    const orgs = await tx.organization.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, timeZone: true },
    });
    for (const o of orgs) {
      const local = localDateHour(now, o.timeZone);
      if (local.hour < DIGEST_HOUR) continue;
      added += await enqueueJobInTx(tx, {
        organizationId: o.id,
        kind: "attention.digest",
        payload: { organizationId: o.id, date: local.date },
        dedupeKey: `attention.digest:${o.id}:${local.date}`,
      });
    }
    return added;
  });
}

// ─── Running ───

type ClaimedJob = {
  id: string;
  organization_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

async function claimNext(workerId: string, now: Date): Promise<ClaimedJob | null> {
  const rows = await getDb().$queryRaw<ClaimedJob[]>`
    UPDATE "jobs" SET "status" = 'RUNNING', "locked_at" = ${now}, "locked_by" = ${workerId},
                      "attempts" = "attempts" + 1
    WHERE "id" = (
      SELECT "id" FROM "jobs" WHERE "status" = 'QUEUED' AND "run_at" <= ${now}
      ORDER BY "run_at", "created_at" FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING "id", "organization_id", "kind", "payload", "attempts", "max_attempts"`;
  return rows[0] ?? null;
}

/** A crashed worker's jobs go back to the queue. */
async function requeueStale(now: Date) {
  const before = new Date(now.getTime() - STALE_AFTER_MINUTES * 60_000);
  return getDb().job.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: before } },
    data: { status: "QUEUED", lockedAt: null, lockedBy: null },
  });
}

/** Tell the organization's administrators that a job gave up (ADR-087). */
async function notifyFailure(job: ClaimedJob) {
  const org = job.organization_id;
  if (!org) return;
  await withTenantTx(org, async (tx) => {
    const admins = (await membersWithGrantsInTx(tx, org))
      .filter((m) => hasPermission(m.grants, "org.settings.manage"))
      .map((m) => m.userId);
    await notifyInTx(tx, org, admins, {
      kind: "JOB_FAILED",
      params: { kind: job.kind },
      link: "/settings/jobs",
      dedupeKey: `job-failed:${job.id}`,
    });
  });
}

/** A short, safe error text: the message only, without stack or values. */
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Run due jobs until none is left or `limit` is reached. Each job runs
 * outside the claim, so a slow job never holds a lock on the queue.
 */
export async function runDueJobs(
  options: {
    limit?: number;
    workerId?: string;
    now?: () => Date;
    handlers?: Partial<Record<string, Handler>>;
  } = {},
) {
  const workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const clock = options.now ?? (() => new Date());
  const handlers: Record<string, Handler | undefined> = { ...HANDLERS, ...options.handlers };
  await requeueStale(clock());
  const ran: Array<{ id: string; kind: string; status: "DONE" | "QUEUED" | "FAILED" }> = [];
  while (ran.length < (options.limit ?? 50)) {
    const job = await claimNext(workerId, clock());
    if (!job) break;
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`Unknown job kind ${job.kind}`);
      const result = await handler(job.payload ?? {});
      await getDb().job.update({
        where: { id: job.id },
        data: { status: "DONE", result, finishedAt: clock(), lastError: null, lockedBy: null },
      });
      ran.push({ id: job.id, kind: job.kind, status: "DONE" });
    } catch (e) {
      const last = job.attempts >= job.max_attempts;
      await getDb().job.update({
        where: { id: job.id },
        data: last
          ? { status: "FAILED", lastError: errorText(e), finishedAt: clock(), lockedBy: null }
          : {
              status: "QUEUED",
              lastError: errorText(e),
              lockedBy: null,
              lockedAt: null,
              runAt: new Date(clock().getTime() + jobRetryDelaySeconds(job.attempts) * 1000),
            },
      });
      if (last) await notifyFailure(job);
      ran.push({ id: job.id, kind: job.kind, status: last ? "FAILED" : "QUEUED" });
    }
  }
  return ran;
}

// ─── The organization's view ───

/** Recent jobs of the organization (system jobs are not shown). */
export async function listJobs(ctx: TenantContext) {
  assertPermission(ctx.grants, "org.settings.manage");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.job.findMany({
      where: { organizationId: ctx.organizationId },
      select: {
        id: true,
        kind: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        runAt: true,
        createdAt: true,
        finishedAt: true,
        lastError: true,
        result: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  );
}
