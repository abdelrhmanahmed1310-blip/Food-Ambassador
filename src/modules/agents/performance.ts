import "server-only";
import { businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { forbidden } from "@/server/errors";
import {
  emptyMonth,
  monthsBack,
  summarize,
  type AgentSummary,
  type MonthFigures,
} from "./performance-rules";
import { AGENT_KINDS, type AgentKindCode } from "./rules";
import { canSeeAgents, canSeeKind } from "./service";

/**
 * Agent performance (DECISIONS.md ADR-150): per agent the person may see and
 * per month in the organization's calendar, what its runs found, what
 * happened to its proposals and what its Claude work used — all counted from
 * the records, nothing estimated.
 */

type Row = Record<string, unknown> & { kind: AgentKindCode; month: string };
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function agentPerformance(
  ctx: TenantContext,
  monthCount = 6,
): Promise<AgentSummary[]> {
  if (!canSeeAgents(ctx)) throw forbidden();
  const kinds = AGENT_KINDS.filter((k) => canSeeKind(ctx, k));
  const months = monthsBack(businessDate(ctx.timeZone).slice(0, 7), monthCount);
  const from = `${months[0]}-01`;
  const org = ctx.organizationId;
  const tz = ctx.timeZone;
  const rows = await withTenantTx(org, async (tx) => {
    const runs = await tx.$queryRaw<Row[]>`
      SELECT a."kind"::text AS kind,
        to_char(r."started_at" AT TIME ZONE ${tz}, 'YYYY-MM') AS month,
        count(*) FILTER (WHERE r."status"::text = 'SUCCEEDED') AS runs,
        count(*) FILTER (WHERE r."status"::text = 'FAILED') AS failed,
        coalesce(sum(coalesce(r."explanation_input_tokens", 0) + coalesce(r."explanation_output_tokens", 0)), 0) AS tokens
      FROM "agent_runs" r JOIN "agents" a ON a."id" = r."agent_id"
      WHERE r."organization_id" = ${org}::uuid
        AND (r."started_at" AT TIME ZONE ${tz})::date >= ${from}::date
      GROUP BY 1, 2`;
    const findings = await tx.$queryRaw<Row[]>`
      SELECT a."kind"::text AS kind,
        to_char(r."started_at" AT TIME ZONE ${tz}, 'YYYY-MM') AS month,
        f->>'severity' AS severity, count(*) AS count
      FROM "agent_runs" r JOIN "agents" a ON a."id" = r."agent_id",
        jsonb_array_elements(r."findings") f
      WHERE r."organization_id" = ${org}::uuid AND r."status"::text = 'SUCCEEDED'
        AND (r."started_at" AT TIME ZONE ${tz})::date >= ${from}::date
      GROUP BY 1, 2, 3`;
    const proposals = await tx.$queryRaw<Row[]>`
      SELECT a."kind"::text AS kind,
        to_char(p."created_at" AT TIME ZONE ${tz}, 'YYYY-MM') AS month,
        count(*) FILTER (WHERE p."kind" <> 'FOLLOW_UP') AS made,
        count(*) FILTER (WHERE p."kind" <> 'FOLLOW_UP' AND p."status"::text = 'APPROVED' AND NOT p."acted_by_agent") AS approved,
        count(*) FILTER (WHERE p."kind" <> 'FOLLOW_UP' AND p."status"::text = 'REJECTED') AS rejected,
        count(*) FILTER (WHERE p."status"::text = 'SUPERSEDED') AS superseded,
        count(*) FILTER (WHERE p."status"::text IN ('OPEN', 'SCHEDULED')) AS open,
        count(*) FILTER (WHERE p."acted_by_agent") AS acted,
        count(*) FILTER (WHERE p."kind" = 'FOLLOW_UP' AND p."status"::text = 'APPROVED') AS follow_ups,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p."decided_at" - p."created_at") / 3600)
          FILTER (WHERE p."decided_at" IS NOT NULL AND NOT p."acted_by_agent" AND p."kind" <> 'FOLLOW_UP') AS median_hours
      FROM "agent_proposals" p JOIN "agents" a ON a."id" = p."agent_id"
      WHERE p."organization_id" = ${org}::uuid
        AND (p."created_at" AT TIME ZONE ${tz})::date >= ${from}::date
      GROUP BY 1, 2`;
    const stopped = await tx.$queryRaw<Row[]>`
      SELECT a."kind"::text AS kind,
        to_char(e."occurred_at" AT TIME ZONE ${tz}, 'YYYY-MM') AS month, count(*) AS count
      FROM "audit_events" e
        JOIN "agent_proposals" p ON p."id" = e."entity_id"
        JOIN "agents" a ON a."id" = p."agent_id"
      WHERE e."organization_id" = ${org}::uuid AND e."action" = 'agent.action_stopped'
        AND (e."occurred_at" AT TIME ZONE ${tz})::date >= ${from}::date
      GROUP BY 1, 2`;
    const investigations = await tx.$queryRaw<Row[]>`
      SELECT a."kind"::text AS kind,
        to_char(i."created_at" AT TIME ZONE ${tz}, 'YYYY-MM') AS month,
        coalesce(sum(i."input_tokens" + i."output_tokens"), 0) AS tokens
      FROM "agent_investigations" i
        JOIN "agent_runs" r ON r."id" = i."run_id"
        JOIN "agents" a ON a."id" = r."agent_id"
      WHERE i."organization_id" = ${org}::uuid
        AND (i."created_at" AT TIME ZONE ${tz})::date >= ${from}::date
      GROUP BY 1, 2`;
    return { runs, findings, proposals, stopped, investigations };
  });

  return kinds.map((kind) => {
    const byMonth = new Map(months.map((m) => [m, emptyMonth(m)]));
    const at = (r: Row) => (r.kind === kind ? byMonth.get(r.month) : undefined);
    for (const r of rows.runs) {
      const m = at(r);
      if (!m) continue;
      m.runs += n(r.runs);
      m.failedRuns += n(r.failed);
      m.aiTokens += n(r.tokens);
    }
    for (const r of rows.findings) {
      const m = at(r);
      const sev = r.severity as keyof MonthFigures["findings"];
      if (m && sev in m.findings) m.findings[sev] += n(r.count);
    }
    for (const r of rows.proposals) {
      const m = at(r);
      if (!m) continue;
      m.proposals += n(r.made);
      m.approved += n(r.approved);
      m.rejected += n(r.rejected);
      m.superseded += n(r.superseded);
      m.open += n(r.open);
      m.actedByAgent += n(r.acted);
      m.followUpsTaken += n(r.follow_ups);
      m.medianDecisionHours =
        r.median_hours === null || r.median_hours === undefined
          ? null
          : Math.round(Number(r.median_hours) * 10) / 10;
    }
    for (const r of rows.stopped) {
      const m = at(r);
      if (m) m.stopped += n(r.count);
    }
    for (const r of rows.investigations) {
      const m = at(r);
      if (m) m.aiTokens += n(r.tokens);
    }
    return summarize(kind, [...byMonth.values()]);
  });
}
