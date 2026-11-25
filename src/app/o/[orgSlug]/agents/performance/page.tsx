import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { agentPerformance } from "@/modules/agents/performance";
import {
  READINESS_APPROVAL_PERCENT,
  READINESS_MIN_DECISIONS,
} from "@/modules/agents/performance-rules";
import { canSeeAgents } from "@/modules/agents/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** How each agent did, month by month, from what was recorded (ADR-150). */
export default async function AgentPerformancePage({
  params,
}: PageProps<"/o/[orgSlug]/agents/performance">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeAgents(ctx)) notFound();
  const [t, format, agents] = await Promise.all([
    getTranslations("agents"),
    getFormatter(),
    agentPerformance(ctx),
  ]);
  const n = (v: number) => format.number(v);
  const tone = { READY: "success", MIXED: "warning", TOO_FEW: "neutral" } as const;
  return (
    <>
      <PageHeader title={t("performanceTitle")} description={t("performanceIntro")} />
      <div className="space-y-6">
        <Alert tone="info">
          {t("readinessRule", {
            min: READINESS_MIN_DECISIONS,
            percent: READINESS_APPROVAL_PERCENT,
          })}
        </Alert>
        {agents.map((a) => (
          <Card key={a.kind} title={t(`kinds.${a.kind}.name`)}>
            <div className="space-y-3" data-testid={`performance-${a.kind}`}>
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={tone[a.readiness]}>{t(`readiness.${a.readiness}`)}</Badge>
                {a.approvalPercent === null
                  ? t("noDecisions")
                  : t("approvalRate", {
                      percent: a.approvalPercent,
                      approved: a.totals.approved,
                      rejected: a.totals.rejected,
                    })}
              </p>
              <Table label={t(`kinds.${a.kind}.name`)}>
                <thead>
                  <tr>
                    <Th>{t("perfMonth")}</Th>
                    <Th>{t("perfRuns")}</Th>
                    <Th>{t("perfFindings")}</Th>
                    <Th>{t("perfProposals")}</Th>
                    <Th>{t("perfApproved")}</Th>
                    <Th>{t("perfRejected")}</Th>
                    <Th>{t("perfActed")}</Th>
                    <Th>{t("perfStopped")}</Th>
                    <Th>{t("perfFollowUps")}</Th>
                    <Th>{t("perfDecisionHours")}</Th>
                    <Th>{t("perfTokens")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {a.months.map((m) => (
                    <tr key={m.month}>
                      <Td className="ltr-value">{m.month}</Td>
                      <Td className="tabular-nums">
                        {n(m.runs)}
                        {m.failedRuns ? ` (+${n(m.failedRuns)} ${t("perfFailed")})` : ""}
                      </Td>
                      <Td className="tabular-nums">
                        {m.findings.CRITICAL ? (
                          <span className="text-danger">{n(m.findings.CRITICAL)} · </span>
                        ) : null}
                        {n(m.findings.WARNING)} · {n(m.findings.INFO)}
                      </Td>
                      <Td className="tabular-nums">{n(m.proposals)}</Td>
                      <Td className="tabular-nums">{n(m.approved)}</Td>
                      <Td className="tabular-nums">{n(m.rejected)}</Td>
                      <Td className="tabular-nums">{n(m.actedByAgent)}</Td>
                      <Td className="tabular-nums">{n(m.stopped)}</Td>
                      <Td className="tabular-nums">{n(m.followUpsTaken)}</Td>
                      <Td className="tabular-nums">
                        {m.medianDecisionHours === null ? "—" : n(m.medianDecisionHours)}
                      </Td>
                      <Td className="tabular-nums">{n(m.aiTokens)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>
        ))}
        <p className="text-muted text-xs">{t("perfNote")}</p>
      </div>
    </>
  );
}
