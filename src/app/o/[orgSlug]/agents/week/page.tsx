import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { weekOverview } from "@/modules/agents/digest";
import { mondayOf } from "@/modules/agents/digest-rules";
import { canSeeAgents } from "@/modules/agents/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** One week of agent work: figures per agent, runs and proposals (ADR-158). */
export default async function AgentWeekPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/agents/week">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeAgents(ctx)) notFound();
  const thisWeek = mondayOf(businessDate(ctx.timeZone));
  const asked = typeof sp.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : null;
  // Last full week by default, as in the Monday summary; never a future week.
  const monday = asked && asked <= thisWeek ? mondayOf(asked) : addDays(thisWeek, -7);
  const [t, format, week] = await Promise.all([
    getTranslations("agents"),
    getFormatter(),
    weekOverview(ctx, monday),
  ]);
  const base = `/o/${orgSlug}`;
  const n = (v: number) => format.number(v);
  const when = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone });
  const prev = addDays(week.from, -7);
  const next = addDays(week.from, 7);
  return (
    <>
      <PageHeader
        title={t("weekTitle")}
        description={t("weekRange", { from: week.from, to: week.to })}
      />
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Link className="text-primary underline" href={`${base}/agents/week?week=${prev}`}>
          {t("weekPrevious")}
        </Link>
        {next <= thisWeek ? (
          <Link className="text-primary underline" href={`${base}/agents/week?week=${next}`}>
            {t("weekNext")}
          </Link>
        ) : null}
      </div>
      <div className="space-y-6">
        <Card title={t("weekByAgent")}>
          <Table label={t("weekByAgent")}>
            <thead>
              <tr>
                <Th>{t("weekAgent")}</Th>
                <Th>{t("perfRuns")}</Th>
                <Th>{t("weekCritical")}</Th>
                <Th>{t("perfProposals")}</Th>
                <Th>{t("perfApproved")}</Th>
                <Th>{t("perfRejected")}</Th>
                <Th>{t("perfActed")}</Th>
              </tr>
            </thead>
            <tbody>
              {week.agents.map((a) => (
                <tr key={a.kind} data-testid={`week-${a.kind}`}>
                  <Td>{t(`kinds.${a.kind}.name`)}</Td>
                  <Td className="tabular-nums">
                    {n(a.figures.runs)}
                    {a.figures.failedRuns
                      ? ` (+${n(a.figures.failedRuns)} ${t("perfFailed")})`
                      : ""}
                  </Td>
                  <Td className="tabular-nums">{n(a.figures.critical)}</Td>
                  <Td className="tabular-nums">{n(a.figures.proposals)}</Td>
                  <Td className="tabular-nums">{n(a.figures.approved)}</Td>
                  <Td className="tabular-nums">{n(a.figures.rejected)}</Td>
                  <Td className="tabular-nums">{n(a.figures.acted)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="text-muted mt-2 text-xs">{t("weekNote")}</p>
        </Card>
        <Card title={t("weekRuns")}>
          {week.runs.length === 0 ? (
            <EmptyState title={t("weekNoRuns")} />
          ) : (
            <ul className="divide-border divide-y text-sm" data-testid="week-runs">
              {week.runs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link className="text-primary underline" href={`${base}/agents/runs/${r.id}`}>
                    {t(`kinds.${r.kind}.name`)} · {when(r.startedAt)}
                  </Link>
                  <span className="flex items-center gap-2">
                    <Badge
                      tone={
                        r.status === "SUCCEEDED"
                          ? "success"
                          : r.status === "FAILED"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {t(`status.${r.status as "SUCCEEDED"}`)}
                    </Badge>
                    {t("weekRunCounts", { findings: r.findings, proposals: r.proposals })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t("weekProposals")}>
          {week.proposals.length === 0 ? (
            <EmptyState title={t("weekNoProposals")} />
          ) : (
            <ul className="divide-border divide-y text-sm" data-testid="week-proposals">
              {week.proposals.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {p.title}
                    <span className="text-muted">
                      {" "}
                      · {t(`kinds.${p.agent}.name`)} · {when(p.createdAt)}
                    </span>
                  </span>
                  <Link
                    className="text-primary underline"
                    href={`${base}/agents/inbox?status=${p.status}`}
                  >
                    {p.actedByAgent ? t("actedByAgent") : t(`proposalStatus.${p.status as "OPEN"}`)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
