import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  Alert,
  Badge,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getRun } from "@/modules/agents/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";

type Figure = {
  branchId: string;
  code: string;
  name: string;
  orders: number;
  sales: string;
  voids: number;
  refunds: number;
};

/** One agent run in full (ADR-140). */
export default async function AgentRunPage({
  params,
}: PageProps<"/o/[orgSlug]/agents/runs/[runId]">) {
  const { orgSlug, runId } = await params;
  if (!isUuid(runId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const run = await notFoundOnAppError(getRun(ctx, runId));
  const [t, format] = await Promise.all([getTranslations("agents"), getFormatter()]);
  const base = `/o/${orgSlug}`;
  const summary = run.summary as Record<string, unknown>;
  const figures = (summary.figures as Figure[] | undefined) ?? [];
  const tone = { CRITICAL: "danger", WARNING: "warning", INFO: "neutral" } as const;
  return (
    <>
      <PageHeader
        title={`${t(`kinds.${run.agent.kind as "REPLENISHMENT"}.name`)} · ${format.dateTime(run.startedAt, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })}`}
        actions={
          <Link href={`${base}/agents/runs`} className="text-primary text-sm hover:underline">
            {t("allRuns")}
          </Link>
        }
      />
      <div className="space-y-6">
        {run.status === "FAILED" ? (
          <Alert tone="error">{t("failed", { error: run.error ?? "" })}</Alert>
        ) : null}
        <Card>
          <DescriptionList
            items={[
              { label: t("statusLabel"), value: t(`status.${run.status}`) },
              { label: t("trigger"), value: t(`triggers.${run.trigger}`) },
              {
                label: t("autonomyLabel"),
                value: t(`autonomy.${run.agent.kind as "REPLENISHMENT"}.${run.agent.autonomy}`),
              },
              ...(run.businessDate
                ? [{ label: t("day"), value: run.businessDate.toISOString().slice(0, 10) }]
                : []),
              {
                label: t("work"),
                value: t("workDetail", { calls: run.toolCalls, ms: run.durationMs ?? 0 }),
              },
            ]}
          />
        </Card>
        {figures.length > 0 ? (
          <Card title={t("figures")}>
            <Table label={t("figures")}>
              <thead>
                <tr>
                  <Th>{t("branch")}</Th>
                  <Th>{t("orders")}</Th>
                  <Th>{t("sales")}</Th>
                  <Th>{t("voids")}</Th>
                  <Th>{t("refunds")}</Th>
                </tr>
              </thead>
              <tbody>
                {figures.map((f) => (
                  <tr key={f.branchId}>
                    <Td>
                      <span className="ltr-value font-mono text-xs">{f.code}</span> — {f.name}
                    </Td>
                    <Td className="tabular-nums">{f.orders}</Td>
                    <Td className="ltr-value tabular-nums">{f.sales}</Td>
                    <Td className="tabular-nums">{f.voids}</Td>
                    <Td className="tabular-nums">{f.refunds}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : null}
        <Card title={t("findingsLabel")}>
          {run.findings.length === 0 ? (
            <p className="text-muted text-sm">{t("noFindings")}</p>
          ) : (
            <ul className="space-y-2 text-sm" data-testid="findings">
              {run.findings.map((f, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={tone[f.severity]}>{t(`severity.${f.severity}`)}</Badge>
                  <span>{t(`findings.${f.code as "NO_SALES"}`, f.params)}</span>
                  {f.link ? (
                    <Link
                      href={`${base}/${f.link}`}
                      className="text-primary text-xs hover:underline"
                    >
                      {t("open")}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {run.proposals.length > 0 ? (
          <Card title={t("proposalsLabel")}>
            <ul className="divide-border divide-y text-sm">
              {run.proposals.map((p) => (
                <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>{p.title}</span>
                  <span>
                    {t(`proposalKinds.${p.kind as "REORDER"}`)} · {t(`proposalStatus.${p.status}`)}
                  </span>
                </li>
              ))}
            </ul>
            <Link
              href={`${base}/agents/inbox`}
              className="text-primary mt-3 inline-block text-sm hover:underline"
            >
              {t("toInbox")}
            </Link>
          </Card>
        ) : null}
      </div>
    </>
  );
}
