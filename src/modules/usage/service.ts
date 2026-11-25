import "server-only";
import { toCsv } from "@/lib/csv";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { validationFailed } from "@/server/errors";
import { logger } from "@/server/logger";
import {
  isMonth,
  LIMIT_METRICS,
  limitWindow,
  monthOf,
  readLimits,
  remaining,
  USAGE_METRICS,
  usageLimitsSchema,
  type LimitKey,
  type UsageMetric,
} from "./rules";

/**
 * Usage metering (DECISIONS.md ADR-146): counters per organization, day (in
 * its own calendar), metric and dimension; the organization's own limits;
 * and a monthly statement. Counting never fails the work it counts.
 */

async function organization(organizationId: string) {
  return withTenantTx(organizationId, (tx) =>
    tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timeZone: true, usageLimits: true },
    }),
  );
}

/** Add to a counter. Errors are logged, never thrown. */
export async function recordUsage(
  organizationId: string,
  metric: UsageMetric,
  quantity: number,
  dimension = "",
  timeZone?: string,
) {
  if (!(quantity > 0)) return;
  try {
    const tz = timeZone ?? (await organization(organizationId)).timeZone;
    const day = businessDate(tz);
    await withTenantTx(
      organizationId,
      (tx) =>
        tx.$executeRaw`
        INSERT INTO "usage_daily" ("id", "organization_id", "day", "metric", "dimension", "quantity", "updated_at")
        VALUES (gen_random_uuid(), ${organizationId}::uuid, ${day}::date, ${metric}, ${dimension.slice(0, 100)}, ${Math.round(quantity)}, now())
        ON CONFLICT ("organization_id", "day", "metric", "dimension")
        DO UPDATE SET "quantity" = "usage_daily"."quantity" + EXCLUDED."quantity", "updated_at" = now()`,
    );
  } catch (error) {
    logger.warn("usage not recorded", {
      metric,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function usedInWindow(
  organizationId: string,
  metrics: readonly UsageMetric[],
  from: string,
  to: string,
) {
  const rows = await withTenantTx(organizationId, (tx) =>
    tx.usageDaily.aggregate({
      where: {
        organizationId,
        metric: { in: [...metrics] },
        day: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
      },
      _sum: { quantity: true },
    }),
  );
  return Number(rows._sum.quantity ?? 0);
}

/** How much is left under one of the organization's limits (null: no limit). */
export async function usageLeft(organizationId: string, key: LimitKey) {
  const org = await organization(organizationId);
  const limit = readLimits(org.usageLimits)[key];
  if (limit === null) return { limit: null, used: 0, left: null as number | null };
  const w = limitWindow(key, businessDate(org.timeZone));
  const used = await usedInWindow(organizationId, LIMIT_METRICS[key], w.from, w.to);
  return { limit, used, left: remaining(limit, used) };
}

export async function withinLimit(organizationId: string, key: LimitKey) {
  const r = await usageLeft(organizationId, key);
  return r.left === null || r.left > 0;
}

// ─── Settings → Usage ───

/** A month's usage per metric and dimension, with the limits and what is used under them. */
export async function usageSummary(ctx: TenantContext, rawMonth?: string) {
  assertPermission(ctx.grants, "org.settings.manage");
  const today = businessDate(ctx.timeZone);
  const month = rawMonth && isMonth(rawMonth) ? monthOf(`${rawMonth}-01`) : monthOf(today);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.usageDaily.groupBy({
      by: ["metric", "dimension"],
      where: {
        organizationId: ctx.organizationId,
        day: {
          gte: new Date(`${month.from}T00:00:00Z`),
          lte: new Date(`${month.to}T00:00:00Z`),
        },
      },
      _sum: { quantity: true },
      orderBy: [{ metric: "asc" }, { dimension: "asc" }],
    });
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: { usageLimits: true },
    });
    const limits = readLimits(org.usageLimits);
    const lines = rows.map((r) => ({
      metric: r.metric as UsageMetric,
      dimension: r.dimension,
      quantity: Number(r._sum.quantity ?? 0),
    }));
    const totals = Object.fromEntries(
      USAGE_METRICS.map((m) => [
        m,
        lines.filter((l) => l.metric === m).reduce((a, l) => a + l.quantity, 0),
      ]),
    ) as Record<UsageMetric, number>;
    const usedFor = async (key: LimitKey) => {
      const w = limitWindow(key, today);
      return usedInWindow(ctx.organizationId, LIMIT_METRICS[key], w.from, w.to);
    };
    return {
      month: month.month,
      currentMonth: monthOf(today).month,
      lines,
      totals,
      limits,
      // Against the current period, whatever month is shown.
      used: {
        agentActionsPerMonth: await usedFor("agentActionsPerMonth"),
        aiTokensPerMonth: await usedFor("aiTokensPerMonth"),
        mcpCallsPerDay: await usedFor("mcpCallsPerDay"),
      },
    };
  });
}

export async function saveUsageLimits(ctx: TenantContext, raw: unknown) {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = usageLimitsSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.organization.update({
      where: { id: ctx.organizationId },
      data: { usageLimits: parsed.data },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "usage.limits_updated",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: parsed.data,
    });
  });
}

/** The month's statement: one line per day, metric and dimension, for invoicing. */
export async function usageStatementCsv(ctx: TenantContext, rawMonth: string) {
  assertPermission(ctx.grants, "org.settings.manage");
  const month = isMonth(rawMonth) ? monthOf(`${rawMonth}-01`) : monthOf(businessDate(ctx.timeZone));
  const rows = await withTenantTx(ctx.organizationId, (tx) =>
    tx.usageDaily.findMany({
      where: {
        organizationId: ctx.organizationId,
        day: {
          gte: new Date(`${month.from}T00:00:00Z`),
          lte: new Date(`${month.to}T00:00:00Z`),
        },
      },
      orderBy: [{ day: "asc" }, { metric: "asc" }, { dimension: "asc" }],
    }),
  );
  return toCsv(
    ["organization", "month", "day", "metric", "dimension", "quantity"],
    rows.map((r) => [
      ctx.organizationSlug,
      month.month,
      r.day.toISOString().slice(0, 10),
      r.metric,
      r.dimension,
      r.quantity.toString(),
    ]),
  );
}
