import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { AgentForm } from "@/components/agents/agent-form";
import { ActionForm } from "@/components/forms/fields";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { AUTONOMY_FOR } from "@/modules/agents/rules";
import { agentFormOptions, listAgents } from "@/modules/agents/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { runAgentNowAction, saveAgentAction } from "./actions";

/** Agents and what they may do (ADR-140, AgaaS Phase 0). */
export default async function AgentsPage({ params }: PageProps<"/o/[orgSlug]/agents">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, format, agents, o] = await Promise.all([
    getTranslations("agents"),
    getFormatter(),
    listAgents(ctx),
    agentFormOptions(ctx),
  ]);
  const when = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone });
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="space-y-6">
        <Alert tone="info">{t("draftOnly")}</Alert>
        {agents.map((a) => (
          <Card key={a.id} title={t(`kinds.${a.kind}.name`)}>
            <div className="space-y-4" data-testid={`agent-${a.kind}`}>
              <p className="text-muted text-sm">{t(`kinds.${a.kind}.does`)}</p>
              <p className="text-sm">
                {a.enabled ? (
                  <Badge tone="success">{t("on")}</Badge>
                ) : (
                  <Badge tone="neutral">{t("off")}</Badge>
                )}{" "}
                {a.enabled && a.runAsName ? t("runsAs", { name: a.runAsName }) : null}
                {a.lastRun ? (
                  <>
                    {" · "}
                    <Link
                      href={`/o/${orgSlug}/agents/runs/${a.lastRun.id}`}
                      className="text-primary hover:underline"
                    >
                      {t("lastRun", {
                        when: when(a.lastRun.startedAt),
                        status: t(`status.${a.lastRun.status}`),
                      })}
                    </Link>
                  </>
                ) : null}
                {a.openProposals ? (
                  <>
                    {" · "}
                    <Link
                      href={`/o/${orgSlug}/agents/inbox`}
                      className="text-primary hover:underline"
                    >
                      {t("openProposals", { count: a.openProposals })}
                    </Link>
                  </>
                ) : null}
              </p>
              <AgentForm
                action={saveAgentAction.bind(null, orgSlug, a.kind)}
                kind={a.kind}
                defaults={{
                  enabled: a.enabled,
                  autonomy: a.autonomy,
                  runHour: a.runHour,
                  ...a.settings,
                }}
                options={{
                  autonomy: AUTONOMY_FOR[a.kind].map((k) => ({
                    value: k,
                    label: t(`autonomy.${a.kind}.${k}` as "autonomy.REPLENISHMENT.SUGGEST"),
                  })),
                  hours: Array.from({ length: 24 }, (_, h) => ({
                    value: String(h),
                    label: `${String(h).padStart(2, "0")}:00`,
                  })),
                  warehouses: o.warehouses.map((w) => ({
                    value: w.id,
                    label: `${w.code} — ${w.name}`,
                  })),
                  branches: o.branches.map((b) => ({
                    value: b.id,
                    label: `${b.code} — ${b.name}`,
                  })),
                  bases: (["MIN_MAX", "FORECAST"] as const).map((k) => ({
                    value: k,
                    label: t(`bases.${k}`),
                  })),
                }}
                labels={{
                  save: t("save"),
                  saving: t("saving"),
                  enabled: t("enabled"),
                  autonomy: t("autonomyLabel"),
                  runHour: t("runHour"),
                  warehouses: t("warehouses"),
                  warehousesHint: t("warehousesHint"),
                  basis: t("basis"),
                  branches: t("branches"),
                  branchesHint: t("branchesHint"),
                  cashTolerance: t("cashTolerance"),
                  voidAlertPercent: t("voidAlertPercent"),
                  salesDropPercent: t("salesDropPercent"),
                  minCreditAmount: t("minCreditAmount"),
                  uninvoicedAfterDays: t("uninvoicedAfterDays"),
                  complianceBelowPercent: t("complianceBelowPercent"),
                  expiringWithinDays: t("expiringWithinDays"),
                  effectiveInDays: t("effectiveInDays"),
                }}
              />
              <div className="border-border border-t pt-4">
                <ActionForm
                  action={runAgentNowAction.bind(null, orgSlug, a.kind)}
                  submitLabel={t("runNow")}
                  pendingLabel={t("running")}
                  submitVariant="secondary"
                >
                  <p className="text-muted text-xs">{t("runNowHint")}</p>
                </ActionForm>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
