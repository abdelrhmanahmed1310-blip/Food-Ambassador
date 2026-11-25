import "server-only";
import { featureOn } from "@/modules/features/access";
import { membersWithGrantsInTx, notifyInTx } from "@/modules/notifications/service";
import { resolveTenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { addDays } from "@/modules/inventory/rules";
import { digestFor, emptyWeek, mondayOf, previousWeek, type WeekFigures } from "./digest-rules";
import { AGENT_KINDS, type AgentKindCode } from "./rules";
import { canSeeAgents, canSeeKind, listProposals } from "./service";
import type { TenantContext } from "@/modules/tenancy/context";
import { forbidden } from "@/server/errors";

/**
 * The weekly agent digest (DECISIONS.md ADR-153): on Monday morning in the
 * organization's time zone, each member who may see agents gets one in-app
 * notification with last week's runs, critical findings, proposals and what
 * people and agents did with them, and how many proposals wait for them now.
 * Only the agents that person may see count; quiet weeks send nothing.
 */

type Row = { kind: string } & Record<string, unknown>;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** Each agent kind's figures for the days from `from` up to (not including) `until`. */
async function weekFiguresInTx(
  tx: Tx,
  organizationId: string,
  tz: string,
  from: string,
  until: string,
) {
  const runs = await tx.$queryRaw<Row[]>`
    SELECT a."kind"::text AS kind,
      count(*) FILTER (WHERE r."status"::text = 'SUCCEEDED') AS runs,
      count(*) FILTER (WHERE r."status"::text = 'FAILED') AS failed,
      coalesce(sum((SELECT count(*) FROM jsonb_array_elements(r."findings") f
        WHERE f->>'severity' = 'CRITICAL')) FILTER (WHERE r."status"::text = 'SUCCEEDED'), 0) AS critical
    FROM "agent_runs" r JOIN "agents" a ON a."id" = r."agent_id"
    WHERE r."organization_id" = ${organizationId}::uuid
      AND (r."started_at" AT TIME ZONE ${tz})::date >= ${from}::date
      AND (r."started_at" AT TIME ZONE ${tz})::date < ${until}::date
    GROUP BY 1`;
  const proposals = await tx.$queryRaw<Row[]>`
    SELECT a."kind"::text AS kind, count(*) AS made
    FROM "agent_proposals" p JOIN "agents" a ON a."id" = p."agent_id"
    WHERE p."organization_id" = ${organizationId}::uuid AND p."kind" <> 'FOLLOW_UP'
      AND (p."created_at" AT TIME ZONE ${tz})::date >= ${from}::date
      AND (p."created_at" AT TIME ZONE ${tz})::date < ${until}::date
    GROUP BY 1`;
  // Decisions taken during the week, whenever the proposal was made.
  const decided = await tx.$queryRaw<Row[]>`
    SELECT a."kind"::text AS kind,
      count(*) FILTER (WHERE p."status"::text = 'APPROVED' AND NOT p."acted_by_agent") AS approved,
      count(*) FILTER (WHERE p."status"::text = 'REJECTED') AS rejected,
      count(*) FILTER (WHERE p."acted_by_agent") AS acted
    FROM "agent_proposals" p JOIN "agents" a ON a."id" = p."agent_id"
    WHERE p."organization_id" = ${organizationId}::uuid AND p."kind" <> 'FOLLOW_UP'
      AND p."decided_at" IS NOT NULL
      AND (p."decided_at" AT TIME ZONE ${tz})::date >= ${from}::date
      AND (p."decided_at" AT TIME ZONE ${tz})::date < ${until}::date
    GROUP BY 1`;
  const byKind = new Map<AgentKindCode, WeekFigures>();
  const get = (kind: string) => {
    const k = kind as AgentKindCode;
    if (!byKind.has(k)) byKind.set(k, emptyWeek());
    return byKind.get(k)!;
  };
  for (const r of runs) {
    const w = get(r.kind);
    w.runs += n(r.runs);
    w.failedRuns += n(r.failed);
    w.critical += n(r.critical);
  }
  for (const r of proposals) get(r.kind).proposals += n(r.made);
  for (const r of decided) {
    const w = get(r.kind);
    w.approved += n(r.approved);
    w.rejected += n(r.rejected);
    w.acted += n(r.acted);
  }
  return byKind;
}

export async function weeklyAgentDigest(organizationId: string, monday: string) {
  const week = previousWeek(monday);
  if (!week) return { members: 0, notified: 0 };
  const org = await withSystemTx((tx) =>
    tx.organization.findUnique({
      where: { id: organizationId },
      select: { slug: true, status: true, timeZone: true, disabledFeatures: true },
    }),
  );
  if (!org || org.status !== "ACTIVE" || !featureOn(org, "agents.center"))
    return { members: 0, notified: 0 };
  const tz = org.timeZone;
  const from = week.from;
  const until = addDays(week.to, 1);

  const { byKind, members } = await withTenantTx(organizationId, async (tx) => {
    const agents = await tx.agent.count({ where: { organizationId } });
    if (agents === 0) return { byKind: new Map<AgentKindCode, WeekFigures>(), members: [] };
    const byKind = await weekFiguresInTx(tx, organizationId, tz, from, until);
    return { byKind, members: await membersWithGrantsInTx(tx, organizationId) };
  });

  let notified = 0;
  for (const m of members) {
    // The same view the person gets in the app: their agents, their proposals.
    const ctx = await withSystemTx((tx) =>
      resolveTenantContext(tx, m.userId, org.slug, `agent-digest:${monday}`),
    );
    if (!ctx) continue;
    const kinds = AGENT_KINDS.filter((k) => canSeeKind(ctx, k));
    if (kinds.length === 0) continue;
    const waiting = (await listProposals(ctx, { status: "OPEN" })).items.length;
    const d = digestFor(byKind, kinds, waiting);
    if (!d) continue;
    notified += await withTenantTx(organizationId, (tx) =>
      notifyInTx(tx, organizationId, [m.userId], {
        kind: "AGENT_WEEKLY_DIGEST",
        params: { from: week.from, to: week.to, ...d },
        link: `/agents/week?week=${week.from}`,
        dedupeKey: `agent-digest:${week.from}`,
      }),
    );
  }
  return { members: members.length, notified };
}

/**
 * One week of agent work for the Weekly page (ADR-158): the digest figures
 * per agent the person may see, the runs and the proposals made that week.
 */
export async function weekOverview(ctx: TenantContext, monday: string) {
  if (!canSeeAgents(ctx)) throw forbidden();
  const from = mondayOf(monday);
  const until = addDays(from, 7);
  const kinds = AGENT_KINDS.filter((k) => canSeeKind(ctx, k));
  const tz = ctx.timeZone;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const byKind = await weekFiguresInTx(tx, ctx.organizationId, tz, from, until);
    const inWeek = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT r."id" FROM "agent_runs" r
      WHERE r."organization_id" = ${ctx.organizationId}::uuid
        AND (r."started_at" AT TIME ZONE ${tz})::date >= ${from}::date
        AND (r."started_at" AT TIME ZONE ${tz})::date < ${until}::date`;
    const proposalIds = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT p."id" FROM "agent_proposals" p
      WHERE p."organization_id" = ${ctx.organizationId}::uuid
        AND (p."created_at" AT TIME ZONE ${tz})::date >= ${from}::date
        AND (p."created_at" AT TIME ZONE ${tz})::date < ${until}::date`;
    const [runs, proposals] = await Promise.all([
      tx.agentRun.findMany({
        where: {
          organizationId: ctx.organizationId,
          id: { in: inWeek.map((r) => r.id) },
          agent: { kind: { in: [...kinds] } },
        },
        orderBy: { startedAt: "desc" },
        take: 200,
        select: {
          id: true,
          status: true,
          startedAt: true,
          findings: true,
          agent: { select: { kind: true } },
          _count: { select: { proposals: true } },
        },
      }),
      tx.agentProposal.findMany({
        where: {
          organizationId: ctx.organizationId,
          id: { in: proposalIds.map((p) => p.id) },
          agent: { kind: { in: [...kinds] } },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true,
          kind: true,
          status: true,
          title: true,
          createdAt: true,
          actedByAgent: true,
          agent: { select: { kind: true } },
        },
      }),
    ]);
    return {
      from,
      to: addDays(from, 6),
      agents: kinds.map((kind) => ({ kind, figures: byKind.get(kind) ?? emptyWeek() })),
      runs: runs.map((r) => ({
        id: r.id,
        kind: r.agent.kind as AgentKindCode,
        status: r.status,
        startedAt: r.startedAt,
        findings: Array.isArray(r.findings) ? r.findings.length : 0,
        proposals: r._count.proposals,
      })),
      proposals: proposals.map((p) => ({
        id: p.id,
        agent: p.agent.kind as AgentKindCode,
        kind: p.kind,
        status: p.status,
        title: p.title,
        createdAt: p.createdAt,
        actedByAgent: p.actedByAgent,
      })),
    };
  });
}
