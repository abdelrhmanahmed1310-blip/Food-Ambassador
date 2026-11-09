import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { accessibleScope, assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { enqueueJobInTx } from "@/modules/jobs/service";
import { uuidSchema } from "@/modules/shared/schemas";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import { applyNormalizedInTx, dictionaryInTx, learnNutrients, type ApplyResult } from "./foods";
import { normalizeFdcFood, standardize, type NormalizedFood } from "./normalize";
import { ProviderError, USDA_DATA_TYPES, usdaProvider } from "./providers";

/**
 * Synchronization with USDA FoodData Central (DECISIONS.md ADR-132). Every
 * run is a job with progress, a checkpoint and its errors. Records are
 * written one transaction per record (or per chunk for files), so a failure
 * never undoes what is already there and a rerun continues from the
 * checkpoint; applying the same content twice changes nothing.
 */

const MAX_ERRORS = 200;
const BATCH = 20;

const manageAll = (ctx: TenantContext) => {
  assertPermission(ctx.grants, "nutrition.manage");
  if (!accessibleScope(ctx.grants, "nutrition.manage").all) throw forbidden();
};

// ─── Settings ───

export async function getNutritionSettings(ctx: TenantContext) {
  assertPermission(ctx.grants, "nutrition.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await tx.nutritionSettings.findUnique({
      where: { organizationId: ctx.organizationId },
    });
    return {
      autoRefresh: s?.autoRefresh ?? false,
      refreshDays: s?.refreshDays ?? 90,
      releases: (s?.releases ?? {}) as Record<string, string>,
      lastReleaseCheckAt: s?.lastReleaseCheckAt ?? null,
    };
  });
}

/** Refresh policy: whether USDA records are refreshed every night, and after how many days a record is stale. */
export async function updateNutritionSettings(ctx: TenantContext, raw: unknown) {
  manageAll(ctx);
  const parsed = z
    .object({
      autoRefresh: z
        .union([z.boolean(), z.literal("on"), z.literal("")])
        .transform((v) => v === true || v === "on")
        .default(false),
      refreshDays: z.coerce.number().int().min(1).max(3650),
    })
    .safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const data = { ...parsed.data, updatedByUserId: ctx.userId };
    await tx.nutritionSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ...data },
      update: data,
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "nutrition.settings_changed",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: parsed.data,
    });
  });
}

// ─── Requesting runs ───

const requestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("IMPORT"),
    fdcIds: z
      .array(
        z.union([z.string().regex(/^\d{1,10}$/), z.number().int().positive().transform(String)]),
      )
      .min(1)
      .max(5000),
  }),
  z.object({
    kind: z.literal("REFRESH"),
    limit: z.coerce.number().int().min(1).max(10000).default(500),
  }),
  z.object({ kind: z.literal("RELEASE_CHECK") }),
]);

/** Queue a sync run (organization-wide nutrition managers only); the job runner carries it out. */
export async function requestSync(ctx: TenantContext, raw: unknown) {
  manageAll(ctx);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const r = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const job = await tx.nutritionSyncJob.create({
      data: {
        organizationId: ctx.organizationId,
        kind: r.kind,
        request: (r.kind === "IMPORT"
          ? { fdcIds: [...new Set(r.fdcIds)] }
          : r.kind === "REFRESH"
            ? { limit: r.limit }
            : {}) as Prisma.InputJsonValue,
        total: r.kind === "IMPORT" ? new Set(r.fdcIds).size : 0,
        requestedByUserId: ctx.userId,
      },
    });
    await enqueueJobInTx(tx, {
      organizationId: ctx.organizationId,
      kind: "nutrition.sync",
      payload: { syncJobId: job.id },
      dedupeKey: `nutrition.sync:${job.id}:0`,
      maxAttempts: 1,
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "nutrition.sync_requested",
      entityType: "nutrition_sync_job",
      entityId: job.id,
      changes: { kind: r.kind },
    });
    return job;
  });
}

/** Run a failed or partly failed job again; it continues from its checkpoint. */
export async function retrySyncJob(ctx: TenantContext, jobId: string) {
  manageAll(ctx);
  const id = uuidSchema.safeParse(jobId);
  if (!id.success) throw notFound("Sync job");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const job = await tx.nutritionSyncJob.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data },
    });
    if (!job) throw notFound("Sync job");
    if (job.status !== "FAILED" && job.status !== "PARTIAL")
      throw businessRuleViolation(
        "SYNC_NOT_RETRYABLE",
        "Only a failed or partly failed run is retried",
      );
    if (job.kind === "BULK_FILE")
      throw businessRuleViolation(
        "SYNC_NOT_RETRYABLE",
        "Rerun the file import command; it continues from its checkpoint",
      );
    await tx.nutritionSyncJob.update({ where: { id: job.id }, data: { status: "QUEUED" } });
    await enqueueJobInTx(tx, {
      organizationId: ctx.organizationId,
      kind: "nutrition.sync",
      payload: { syncJobId: job.id },
      dedupeKey: `nutrition.sync:${job.id}:${job.attempts}`,
      maxAttempts: 1,
    });
    return { id: job.id };
  });
}

// ─── Running ───

type Job = Awaited<ReturnType<typeof loadJob>>;
const loadJob = (id: string) =>
  withSystemTx((tx) =>
    tx.nutritionSyncJob.findUnique({
      where: { id },
      include: { organization: { select: { slug: true } } },
    }),
  );

async function save(
  job: { id: string; organizationId: string },
  data: Prisma.NutritionSyncJobUncheckedUpdateInput,
) {
  await withTenantTx(job.organizationId, (tx) =>
    tx.nutritionSyncJob.update({ where: { id: job.id }, data }),
  );
}

/** The person who asked, as they are now: their rights decide whether the run may proceed. */
async function contextFor(job: NonNullable<Job>) {
  if (!job.requestedByUserId) return null;
  const ctx = await withSystemTx((tx) =>
    resolveTenantContext(tx, job.requestedByUserId!, job.organization.slug),
  );
  return ctx && hasPermission(ctx.grants, "nutrition.manage") ? ctx : null;
}

class Tally {
  created = 0;
  updated = 0;
  unchanged = 0;
  failed = 0;
  processed = 0;
  errors: Array<{ ref: string; message: string }>;
  constructor(job: NonNullable<Job>) {
    this.created = job.created;
    this.updated = job.updated;
    this.unchanged = job.unchanged;
    this.failed = job.failed;
    this.processed = job.processed;
    this.errors = (job.errors as Array<{ ref: string; message: string }>) ?? [];
  }
  add(r: ApplyResult["result"]) {
    this[r]++;
    this.processed++;
  }
  fail(ref: string, message: string) {
    this.failed++;
    this.processed++;
    if (this.errors.length < MAX_ERRORS) this.errors.push({ ref, message: message.slice(0, 300) });
  }
  get data() {
    return {
      created: this.created,
      updated: this.updated,
      unchanged: this.unchanged,
      failed: this.failed,
      processed: this.processed,
      errors: this.errors as Prisma.InputJsonValue,
    };
  }
}

/** Fetch and apply a batch of FDC ids; returns false when the provider cannot be used any further. */
async function applyBatch(
  ctx: TenantContext,
  jobId: string,
  ids: readonly string[],
  tally: Tally,
): Promise<boolean> {
  let payloads: unknown[];
  try {
    payloads = await usdaProvider().foods(ids);
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : "UNAVAILABLE";
    for (const id of ids) tally.fail(id, (error as Error).message);
    return !(code === "NOT_CONFIGURED" || code === "RATE_LIMITED" || code === "UNAVAILABLE");
  }
  const seen = new Set<string>();
  for (const raw of payloads) {
    const food = normalizeFdcFood(raw);
    if (!food) {
      tally.fail("?", "Unreadable record");
      continue;
    }
    seen.add(food.sourceId);
    try {
      tally.add((await applyOne(ctx, food, raw, "API", jobId)).result);
    } catch (error) {
      tally.fail(food.sourceId, (error as Error).message);
    }
  }
  for (const id of ids) if (!seen.has(id)) tally.fail(id, "Not found in USDA FoodData Central");
  return true;
}

async function applyOne(
  ctx: TenantContext,
  food: NormalizedFood,
  raw: unknown,
  via: "API" | "BULK_FILE",
  jobId: string,
) {
  await learnNutrients(standardize(food, []).unknown);
  return withTenantTx(ctx.organizationId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`food:${ctx.organizationId}:${food.sourceId}`}))`;
    return applyNormalizedInTx(tx, ctx, food, raw, {
      via,
      syncJobId: jobId,
      dictionary: await dictionaryInTx(tx),
    });
  });
}

function finalStatus(t: Tally, stoppedEarly: boolean) {
  if (t.failed === 0 && !stoppedEarly) return "SUCCEEDED" as const;
  return t.created + t.updated + t.unchanged > 0 ? ("PARTIAL" as const) : ("FAILED" as const);
}

/** The job runner's handler: carry out one sync run. */
export async function runSyncJob(
  payload: Record<string, unknown>,
): Promise<Record<string, number>> {
  const id = String(payload.syncJobId ?? "");
  const job = await loadJob(id);
  if (!job || job.status === "SUCCEEDED" || job.status === "RUNNING") return { skipped: 1 };
  await save(job, {
    status: "RUNNING",
    startedAt: job.startedAt ?? new Date(),
    attempts: { increment: 1 },
  });
  const ctx = await contextFor(job);
  const tally = new Tally(job);
  if (!ctx) {
    tally.fail("job", "The person who asked for this run can no longer manage nutrition data");
    await save(job, { ...tally.data, status: "FAILED", finishedAt: new Date() });
    return { failed: 1 };
  }
  if (!usdaProvider().configured()) {
    tally.fail("job", "USDA FoodData Central is not configured (USDA_FDC_API_KEY)");
    await save(job, { ...tally.data, status: "FAILED", finishedAt: new Date() });
    return { failed: 1 };
  }
  let stopped = false;
  if (job.kind === "IMPORT") {
    const ids = ((job.request as { fdcIds?: string[] }).fdcIds ?? []).map(String);
    let next = Number((job.checkpoint as { next?: number }).next ?? 0);
    for (; next < ids.length; next += BATCH) {
      if (!(await applyBatch(ctx, job.id, ids.slice(next, next + BATCH), tally))) {
        stopped = true;
        next += BATCH;
        break;
      }
      await save(job, { ...tally.data, checkpoint: { next: next + BATCH } });
    }
    await save(job, { ...tally.data, checkpoint: { next: Math.min(next, ids.length) } });
  } else if (job.kind === "REFRESH") {
    const limit = Number((job.request as { limit?: number }).limit ?? 500);
    const settings = await withTenantTx(job.organizationId, (tx) =>
      tx.nutritionSettings.findUnique({ where: { organizationId: job.organizationId } }),
    );
    const before = new Date(Date.now() - (settings?.refreshDays ?? 90) * 86_400_000);
    // Refreshed records leave the stale set, so a rerun naturally continues where this one stopped.
    const stale = await withTenantTx(job.organizationId, (tx) =>
      tx.referenceFood.findMany({
        where: {
          organizationId: job.organizationId,
          source: "USDA_FDC",
          archivedAt: null,
          OR: [{ lastFetchedAt: null }, { lastFetchedAt: { lt: before } }],
        },
        orderBy: [{ lastFetchedAt: { sort: "asc", nulls: "first" } }],
        take: limit,
        select: { sourceId: true },
      }),
    );
    await save(job, { total: stale.length + job.processed });
    for (let i = 0; i < stale.length; i += BATCH) {
      if (
        !(await applyBatch(
          ctx,
          job.id,
          stale.slice(i, i + BATCH).map((s) => s.sourceId),
          tally,
        ))
      ) {
        stopped = true;
        break;
      }
      await save(job, tally.data);
    }
  } else if (job.kind === "RELEASE_CHECK") {
    const found: Record<string, string> = {};
    for (const dt of USDA_DATA_TYPES) {
      try {
        const d = await usdaProvider().latestPublished(dt);
        if (d) found[dt] = d;
        tally.processed++;
      } catch (error) {
        tally.fail(dt, (error as Error).message);
      }
    }
    await withTenantTx(job.organizationId, async (tx) => {
      const s = await tx.nutritionSettings.findUnique({
        where: { organizationId: job.organizationId },
      });
      const previous = (s?.releases ?? {}) as Record<string, string>;
      const changed = Object.keys(found).filter((k) => previous[k] !== found[k]);
      await tx.nutritionSettings.upsert({
        where: { organizationId: job.organizationId },
        create: {
          organizationId: job.organizationId,
          releases: found,
          lastReleaseCheckAt: new Date(),
        },
        update: { releases: { ...previous, ...found }, lastReleaseCheckAt: new Date() },
      });
      await tx.nutritionSyncJob.update({
        where: { id: job.id },
        data: { checkpoint: { found, previous, changed } as Prisma.InputJsonValue },
      });
    });
  }
  const status = finalStatus(tally, stopped);
  await save(job, { ...tally.data, status, finishedAt: new Date() });
  return { processed: tally.processed, failed: tally.failed };
}

/** Nightly: queue a refresh (and on Mondays a release check) for organizations that switched it on. */
export async function scheduleNutritionRefresh(now = new Date()) {
  const orgs = await withSystemTx((tx) =>
    tx.nutritionSettings.findMany({
      where: { autoRefresh: true, updatedByUserId: { not: null } },
      select: { organizationId: true, updatedByUserId: true },
    }),
  );
  let queued = 0;
  for (const o of orgs) {
    const day = now.toISOString().slice(0, 10);
    await withTenantTx(o.organizationId, async (tx) => {
      const kinds: Array<"REFRESH" | "RELEASE_CHECK"> =
        now.getUTCDay() === 1 ? ["REFRESH", "RELEASE_CHECK"] : ["REFRESH"];
      for (const kind of kinds) {
        const exists = await tx.nutritionSyncJob.findFirst({
          where: {
            organizationId: o.organizationId,
            kind,
            createdAt: { gte: new Date(`${day}T00:00:00Z`) },
          },
          select: { id: true },
        });
        if (exists) continue;
        const job = await tx.nutritionSyncJob.create({
          data: {
            organizationId: o.organizationId,
            kind,
            request: kind === "REFRESH" ? { limit: 500 } : {},
            requestedByUserId: o.updatedByUserId,
          },
        });
        await enqueueJobInTx(tx, {
          organizationId: o.organizationId,
          kind: "nutrition.sync",
          payload: { syncJobId: job.id },
          dedupeKey: `nutrition.sync:${job.id}:0`,
          maxAttempts: 1,
        });
        queued++;
      }
    });
  }
  return { queued };
}

// ─── Bulk files ───

const CHUNK = 200;

/**
 * Import a FoodData Central download from a stream of records (the CLI
 * feeds it from disk without loading the file). Records are normalized and
 * checked before writing (staging); each chunk of 200 is one transaction,
 * retried record by record if it fails, so one bad record never blocks the
 * rest. The checkpoint is the number of records read: rerunning the same
 * file continues after the last finished chunk.
 */
export async function importRecordStream(
  ctx: TenantContext,
  records: AsyncIterable<unknown>,
  file: { name: string; size: number },
) {
  manageAll(ctx);
  const job = await withTenantTx(ctx.organizationId, async (tx) => {
    const previous = await tx.nutritionSyncJob.findFirst({
      where: {
        organizationId: ctx.organizationId,
        kind: "BULK_FILE",
        status: { in: ["RUNNING", "PARTIAL", "FAILED", "QUEUED"] },
        request: { equals: { file: file.name, size: file.size } },
      },
      orderBy: { createdAt: "desc" },
    });
    return (
      previous ??
      tx.nutritionSyncJob.create({
        data: {
          organizationId: ctx.organizationId,
          kind: "BULK_FILE",
          request: { file: file.name, size: file.size },
          requestedByUserId: ctx.userId,
        },
      })
    );
  });
  const full = await withSystemTx((tx) =>
    tx.nutritionSyncJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { organization: { select: { slug: true } } },
    }),
  );
  const tally = new Tally(full);
  const resumeAfter = Number((job.checkpoint as { read?: number }).read ?? 0);
  await save(job, {
    status: "RUNNING",
    startedAt: job.startedAt ?? new Date(),
    attempts: { increment: 1 },
  });
  let read = 0;
  let chunk: Array<{ raw: unknown; food: NormalizedFood }> = [];
  const flush = async () => {
    if (!chunk.length) return;
    await learnNutrients(chunk.flatMap((c) => standardize(c.food, []).unknown));
    try {
      const results = await withTenantTx(ctx.organizationId, async (tx) => {
        const dictionary = await dictionaryInTx(tx);
        const out: ApplyResult[] = [];
        for (const c of chunk)
          out.push(
            await applyNormalizedInTx(tx, ctx, c.food, c.raw, {
              via: "BULK_FILE",
              syncJobId: job.id,
              dictionary,
            }),
          );
        return out;
      });
      for (const r of results) tally.add(r.result);
    } catch {
      // The chunk rolled back as a whole; apply its records one by one to find the bad ones.
      for (const c of chunk)
        try {
          tally.add((await applyOne(ctx, c.food, c.raw, "BULK_FILE", job.id)).result);
        } catch (error) {
          tally.fail(c.food.sourceId, (error as Error).message);
        }
    }
    chunk = [];
    await save(job, { ...tally.data, checkpoint: { read }, total: read });
  };
  try {
    for await (const raw of records) {
      read++;
      if (read <= resumeAfter) continue;
      const food = normalizeFdcFood(raw);
      if (!food) {
        tally.fail(`#${read}`, "No FDC id or description");
        continue;
      }
      chunk.push({ raw, food });
      if (chunk.length >= CHUNK) await flush();
    }
    await flush();
  } catch (error) {
    await flush().catch(() => undefined);
    tally.fail(`#${read}`, `Reading stopped: ${(error as Error).message}`);
    await save(job, { ...tally.data, status: "FAILED", finishedAt: new Date() });
    return { jobId: job.id, ...tally.data, status: "FAILED" as const, resumedAfter: resumeAfter };
  }
  const status = finalStatus(tally, false);
  await save(job, { ...tally.data, status, finishedAt: new Date(), checkpoint: { read } });
  await withTenantTx(ctx.organizationId, (tx) =>
    recordAudit(tx, actorOf(ctx), {
      action: "nutrition.bulk_imported",
      entityType: "nutrition_sync_job",
      entityId: job.id,
      changes: {
        file: file.name,
        read,
        created: tally.created,
        updated: tally.updated,
        failed: tally.failed,
      },
    }),
  );
  return { jobId: job.id, ...tally.data, status, resumedAfter: resumeAfter };
}

// ─── Status ───

export async function syncStatus(ctx: TenantContext) {
  assertPermission(ctx.grants, "nutrition.view");
  const settings = await getNutritionSettings(ctx);
  const configured = usdaProvider().configured();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [last, lastSuccess, running, failed] = await Promise.all([
      tx.nutritionSyncJob.findFirst({
        where: { organizationId: ctx.organizationId },
        orderBy: { createdAt: "desc" },
      }),
      tx.nutritionSyncJob.findFirst({
        where: { organizationId: ctx.organizationId, status: { in: ["SUCCEEDED", "PARTIAL"] } },
        orderBy: { finishedAt: "desc" },
      }),
      tx.nutritionSyncJob.count({
        where: { organizationId: ctx.organizationId, status: { in: ["QUEUED", "RUNNING"] } },
      }),
      tx.nutritionSyncJob.count({
        where: { organizationId: ctx.organizationId, status: "FAILED" },
      }),
    ]);
    return {
      usdaConfigured: configured,
      settings,
      lastJob: last,
      lastSuccessAt: lastSuccess?.finishedAt ?? null,
      running,
      failedJobs: failed,
    };
  });
}

export async function listSyncJobs(ctx: TenantContext, raw: Record<string, unknown> = {}) {
  assertPermission(ctx.grants, "nutrition.view");
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .catch(1)
    .parse(raw.page ?? 1);
  const pageSize = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .catch(25)
    .parse(raw.pageSize ?? 25);
  const status = z
    .enum(["QUEUED", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"])
    .optional()
    .catch(undefined)
    .parse(raw.status);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const where = { organizationId: ctx.organizationId, ...(status ? { status } : {}) };
    const [total, items] = await Promise.all([
      tx.nutritionSyncJob.count({ where }),
      tx.nutritionSyncJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, items };
  });
}

export async function getSyncJob(ctx: TenantContext, jobId: string) {
  assertPermission(ctx.grants, "nutrition.view");
  const id = uuidSchema.safeParse(jobId);
  if (!id.success) throw notFound("Sync job");
  const job = await withTenantTx(ctx.organizationId, (tx) =>
    tx.nutritionSyncJob.findFirst({ where: { organizationId: ctx.organizationId, id: id.data } }),
  );
  if (!job) throw notFound("Sync job");
  return job;
}
