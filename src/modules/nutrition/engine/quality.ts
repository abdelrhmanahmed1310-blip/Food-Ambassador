import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { usdaProvider } from "./providers";

/**
 * Data quality and the nutrition dashboard (DECISIONS.md ADR-132). Findings
 * are raised on import (missing core nutrients, implausible values, units,
 * duplicate barcodes, values changed after verification) and by a scan
 * (stale records, duplicate names, records without their source); a person
 * investigates and resolves or ignores each, with a note.
 */

export const ISSUE_KINDS = [
  "MISSING_CORE_NUTRIENTS",
  "IMPLAUSIBLE_VALUE",
  "UNEXPECTED_UNIT",
  "UNIT_MISMATCH",
  "DUPLICATE_BARCODE",
  "DUPLICATE_NAME",
  "MISSING_SOURCE",
  "STALE",
  "CHANGED_AFTER_VERIFICATION",
] as const;

export async function listIssues(ctx: TenantContext, raw: Record<string, unknown> = {}) {
  assertPermission(ctx.grants, "nutrition.view");
  const status = z
    .enum(["OPEN", "RESOLVED", "IGNORED"])
    .catch("OPEN")
    .parse(raw.status ?? "OPEN");
  const kind = z.enum(ISSUE_KINDS).optional().catch(undefined).parse(raw.kind);
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .catch(1)
    .parse(raw.page ?? 1);
  const pageSize = 50;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const where: Prisma.FoodDataIssueWhereInput = {
      organizationId: ctx.organizationId,
      status,
      ...(kind ? { kind } : {}),
    };
    const [total, items, byKind] = await Promise.all([
      tx.foodDataIssue.count({ where }),
      tx.foodDataIssue.findMany({
        where,
        include: {
          food: { select: { id: true, name: true, nameAr: true, source: true, sourceId: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      tx.foodDataIssue.groupBy({
        by: ["kind"],
        where: { organizationId: ctx.organizationId, status: "OPEN" },
        _count: { _all: true },
      }),
    ]);
    return {
      status,
      kind: kind ?? null,
      total,
      page,
      pageSize,
      items,
      openByKind: Object.fromEntries(byKind.map((k) => [k.kind, k._count._all])),
    };
  });
}

export async function resolveIssue(ctx: TenantContext, issueId: string, raw: unknown) {
  assertPermission(ctx.grants, "nutrition.manage");
  const parsed = z
    .object({
      status: z.enum(["RESOLVED", "IGNORED"]),
      note: z.string().trim().min(1, { error: "required" }).max(500),
    })
    .safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const id = uuidSchema.safeParse(issueId);
  if (!id.success) throw notFound("Finding");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const issue = await tx.foodDataIssue.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data },
    });
    if (!issue) throw notFound("Finding");
    if (issue.status !== "OPEN")
      throw businessRuleViolation("ISSUE_CLOSED", "This finding is already closed");
    await tx.foodDataIssue.update({
      where: { id: issue.id },
      data: {
        status: parsed.data.status,
        resolutionNote: parsed.data.note,
        resolvedAt: new Date(),
        resolvedByUserId: ctx.userId,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "nutrition.issue_closed",
      entityType: "reference_food",
      entityId: issue.foodId,
      changes: { kind: issue.kind, status: parsed.data.status },
    });
    return { id: issue.id };
  });
}

/** Look for stale records, duplicate names and records without their source; new findings only. */
export async function scanQuality(ctx: TenantContext) {
  assertPermission(ctx.grants, "nutrition.manage");
  const org = ctx.organizationId;
  return withTenantTx(org, async (tx) => {
    const refreshDays =
      (await tx.nutritionSettings.findUnique({ where: { organizationId: org } }))?.refreshDays ??
      90;
    const stale = await tx.$executeRaw`
      INSERT INTO "food_data_issues" ("id", "organization_id", "food_id", "kind", "detail", "data")
      SELECT gen_random_uuid(), f."organization_id", f."id", 'STALE', 'Not fetched from USDA for over ' || ${refreshDays} || ' days', '{}'
      FROM "reference_foods" f
      WHERE f."organization_id" = ${org}::uuid AND f."source" = 'USDA_FDC' AND f."archived_at" IS NULL
        AND (f."last_fetched_at" IS NULL OR f."last_fetched_at" < now() - make_interval(days => ${refreshDays}))
      ON CONFLICT DO NOTHING`;
    const duplicates = await tx.$executeRaw`
      INSERT INTO "food_data_issues" ("id", "organization_id", "food_id", "kind", "detail", "data")
      SELECT gen_random_uuid(), f."organization_id", f."id", 'DUPLICATE_NAME', 'Another record has the same name and brand', '{}'
      FROM "reference_foods" f
      WHERE f."organization_id" = ${org}::uuid AND f."archived_at" IS NULL AND EXISTS (
        SELECT 1 FROM "reference_foods" g WHERE g."organization_id" = f."organization_id" AND g."id" <> f."id"
          AND g."archived_at" IS NULL AND lower(g."name") = lower(f."name")
          AND COALESCE(lower(g."brand"), '') = COALESCE(lower(f."brand"), ''))
      ON CONFLICT DO NOTHING`;
    const missingSource = await tx.$executeRaw`
      INSERT INTO "food_data_issues" ("id", "organization_id", "food_id", "kind", "detail", "data")
      SELECT gen_random_uuid(), f."organization_id", f."id", 'MISSING_SOURCE', 'No source record is kept for this food', '{}'
      FROM "reference_foods" f
      WHERE f."organization_id" = ${org}::uuid AND f."archived_at" IS NULL AND f."source" <> 'MANUAL'
        AND NOT EXISTS (SELECT 1 FROM "food_source_versions" v WHERE v."food_id" = f."id") AND f."import_id" IS NULL
      ON CONFLICT DO NOTHING`;
    return { stale, duplicates, missingSource };
  });
}

/** The figures on the nutrition dashboard, from the database. */
export async function nutritionDashboard(ctx: TenantContext) {
  assertPermission(ctx.grants, "nutrition.view");
  const org = ctx.organizationId;
  return withTenantTx(org, async (tx) => {
    const [counts] = await tx.$queryRaw<
      Array<{
        total: bigint;
        usda: bigint;
        branded: bigint;
        foundation: bigint;
        sr: bigint;
        fndds: bigint;
        manual: bigint;
        unverified: bigint;
        archived: bigint;
      }>
    >`SELECT count(*) FILTER (WHERE "archived_at" IS NULL) AS total,
        count(*) FILTER (WHERE "archived_at" IS NULL AND "source" = 'USDA_FDC') AS usda,
        count(*) FILTER (WHERE "archived_at" IS NULL AND "data_type" = 'Branded') AS branded,
        count(*) FILTER (WHERE "archived_at" IS NULL AND "data_type" = 'Foundation') AS foundation,
        count(*) FILTER (WHERE "archived_at" IS NULL AND "data_type" = 'SR Legacy') AS sr,
        count(*) FILTER (WHERE "archived_at" IS NULL AND "data_type" = 'Survey (FNDDS)') AS fndds,
        count(*) FILTER (WHERE "archived_at" IS NULL AND "source" = 'MANUAL') AS manual,
        count(*) FILTER (WHERE "archived_at" IS NULL AND "verified_at" IS NULL) AS unverified,
        count(*) FILTER (WHERE "archived_at" IS NOT NULL) AS archived
      FROM "reference_foods" WHERE "organization_id" = ${org}::uuid`;
    const [nutrients, openIssues, lastJob, lastSuccess, failedJobs] = await Promise.all([
      tx.nutrient.count(),
      tx.foodDataIssue.count({ where: { organizationId: org, status: "OPEN" } }),
      tx.nutritionSyncJob.findFirst({
        where: { organizationId: org },
        orderBy: { createdAt: "desc" },
      }),
      tx.nutritionSyncJob.findFirst({
        where: { organizationId: org, status: { in: ["SUCCEEDED", "PARTIAL"] } },
        orderBy: { finishedAt: "desc" },
      }),
      tx.nutritionSyncJob.count({ where: { organizationId: org, status: "FAILED" } }),
    ]);
    const n = (v: bigint) => Number(v);
    return {
      foods: n(counts.total),
      usda: n(counts.usda),
      branded: n(counts.branded),
      foundation: n(counts.foundation),
      srLegacy: n(counts.sr),
      fndds: n(counts.fndds),
      manual: n(counts.manual),
      awaitingVerification: n(counts.unverified),
      archived: n(counts.archived),
      nutrients,
      openIssues,
      failedJobs,
      lastSyncAt: lastSuccess?.finishedAt ?? null,
      lastJob: lastJob
        ? {
            id: lastJob.id,
            kind: lastJob.kind,
            status: lastJob.status,
            createdAt: lastJob.createdAt,
          }
        : null,
      usdaConfigured: usdaProvider().configured(),
    };
  });
}
