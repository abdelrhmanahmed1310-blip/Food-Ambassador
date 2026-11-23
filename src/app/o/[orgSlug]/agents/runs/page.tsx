import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { canSeeAgents, listRuns } from "@/modules/agents/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** Every agent run: when, what it found and proposed, how much work it took (ADR-140). */
export default async function AgentRunsPage({ params }: PageProps<"/o/[orgSlug]/agents/runs">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeAgents(ctx)) notFound();
  const [t, format, runs] = await Promise.all([
    getTranslations("agents"),
    getFormatter(),
    listRuns(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("runsTitle")} description={t("runsIntro")} />
      {runs.length === 0 ? (
        <EmptyState title={t("noRuns")} />
      ) : (
        <Table label={t("runsTitle")}>
          <thead>
            <tr>
              <Th>{t("started")}</Th>
              <Th>{t("agent")}</Th>
              <Th>{t("trigger")}</Th>
              <Th>{t("statusLabel")}</Th>
              <Th>{t("findingsLabel")}</Th>
              <Th>{t("proposalsLabel")}</Th>
              <Th>{t("work")}</Th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} data-testid="agent-run">
                <Td>
                  <Link
                    href={`/o/${orgSlug}/agents/runs/${r.id}`}
                    className="text-primary hover:underline"
                  >
                    {format.dateTime(r.startedAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: ctx.timeZone,
                    })}
                  </Link>
                </Td>
                <Td>{t(`kinds.${r.agent.kind as "REPLENISHMENT"}.name`)}</Td>
                <Td>{t(`triggers.${r.trigger}`)}</Td>
                <Td>
                  <Badge
                    tone={
                      r.status === "SUCCEEDED"
                        ? "success"
                        : r.status === "FAILED"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {t(`status.${r.status}`)}
                  </Badge>
                </Td>
                <Td className="tabular-nums">
                  {Array.isArray(r.findings) ? r.findings.length : 0}
                </Td>
                <Td className="tabular-nums">{r._count.proposals}</Td>
                <Td className="text-muted text-xs">
                  {t("workDetail", { calls: r.toolCalls, ms: r.durationMs ?? 0 })}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
