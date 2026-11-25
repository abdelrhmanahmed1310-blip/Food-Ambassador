import "server-only";
import { featureOn } from "@/modules/features/access";
import { membersWithGrantsInTx, notifyInTx } from "@/modules/notifications/service";
import { resolveTenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx } from "@/server/db/transactions";
import { addDays } from "@/modules/inventory/rules";
import { digestFor, emptyWeek, previousWeek, type WeekFigures } from "./digest-rules";
import { AGENT_KINDS, type AgentKindCode } from "./rules";
import { canSeeKind, listProposals } from "./service";

/**
 * The weekly agent digest (DECISIONS.md ADR-153): on Monday morning in the
 * organization's time zone, each member who may see agents gets one in-app
 * notification with last week's runs, critical findings, proposals and what
 * people and agents did with them, and how many proposals wait for them now.
 * Only the agents that person may see count; quiet weeks send nothing.
 */

type Row = { kind: string } & Record<string, unknown>;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

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
        link: d.waiting ? "/agents/inbox" : "/agents/performance",
        dedupeKey: `agent-digest:${week.from}`,
      }),
    );
  }
  return { members: members.length, notified };
}
