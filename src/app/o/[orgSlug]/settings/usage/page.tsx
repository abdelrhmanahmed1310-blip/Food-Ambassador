import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ActionForm, TextField } from "@/components/forms/fields";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { monthOf } from "@/modules/usage/rules";
import { usageSummary } from "@/modules/usage/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { saveUsageLimitsAction } from "./actions";

const shift = (month: string, by: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};

/** What the organization used, against its own limits, and the monthly statement (ADR-146). */
export default async function UsagePage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/settings/usage">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, format, u] = await Promise.all([
    getTranslations("usage"),
    getFormatter(),
    usageSummary(ctx, typeof sp.month === "string" ? sp.month : undefined),
  ]);
  const n = (v: number) => format.number(v);
  const base = `/o/${orgSlug}/settings/usage`;
  const limitRow = (key: "agentActionsPerMonth" | "aiTokensPerMonth" | "mcpCallsPerDay") => {
    const limit = u.limits[key];
    return (
      <tr key={key}>
        <Td>{t(`limits.${key}`)}</Td>
        <Td className="tabular-nums">{n(u.used[key])}</Td>
        <Td className="tabular-nums">{limit === null ? t("noLimit") : n(limit)}</Td>
        <Td className="tabular-nums">
          {limit === null
            ? "—"
            : limit === 0
              ? "100%"
              : `${Math.min(Math.round((u.used[key] / limit) * 100), 999)}%`}
        </Td>
      </tr>
    );
  };
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="space-y-6">
        <Card title={t("limitsTitle")}>
          <Table label={t("limitsTitle")}>
            <thead>
              <tr>
                <Th>{t("limit")}</Th>
                <Th>{t("usedNow")}</Th>
                <Th>{t("cap")}</Th>
                <Th>{t("share")}</Th>
              </tr>
            </thead>
            <tbody data-testid="usage-limits">
              {limitRow("agentActionsPerMonth")}
              {limitRow("aiTokensPerMonth")}
              {limitRow("mcpCallsPerDay")}
            </tbody>
          </Table>
          <ActionForm
            action={saveUsageLimitsAction.bind(null, orgSlug)}
            submitLabel={t("save")}
            pendingLabel={t("saving")}
            className="mt-4 space-y-3"
          >
            <p className="text-muted text-xs">{t("limitsHint")}</p>
            <div className="grid gap-4 sm:grid-cols-3">
              {(["agentActionsPerMonth", "aiTokensPerMonth", "mcpCallsPerDay"] as const).map(
                (k) => (
                  <TextField
                    key={k}
                    name={k}
                    label={t(`limits.${k}`)}
                    defaultValue={u.limits[k] === null ? "" : String(u.limits[k])}
                    inputMode="numeric"
                    dir="ltr"
                  />
                ),
              )}
            </div>
          </ActionForm>
        </Card>
        <Card
          title={t("monthTitle", { month: u.month })}
          actions={
            <div className="flex flex-wrap gap-3 text-sm">
              <Link
                href={`${base}?month=${shift(u.month, -1)}`}
                className="text-primary hover:underline"
              >
                {t("previous")}
              </Link>
              {u.month < u.currentMonth ? (
                <Link
                  href={`${base}?month=${shift(u.month, 1)}`}
                  className="text-primary hover:underline"
                >
                  {t("next")}
                </Link>
              ) : null}
              <a href={`${base}/export?month=${u.month}`} className="text-primary hover:underline">
                {t("statementCsv")}
              </a>
              <a
                href={`${base}/export?month=${u.month}&format=xlsx`}
                className="text-primary hover:underline"
              >
                {t("statementXlsx")}
              </a>
            </div>
          }
        >
          {u.lines.length === 0 ? (
            <EmptyState
              title={t("nothing", {
                from: monthOf(`${u.month}-01`).from,
                to: monthOf(`${u.month}-01`).to,
              })}
            />
          ) : (
            <Table label={t("monthTitle", { month: u.month })}>
              <thead>
                <tr>
                  <Th>{t("metric")}</Th>
                  <Th>{t("dimension")}</Th>
                  <Th>{t("quantity")}</Th>
                </tr>
              </thead>
              <tbody data-testid="usage-lines">
                {u.lines.map((l) => (
                  <tr key={`${l.metric}:${l.dimension}`}>
                    <Td>{t(`metrics.${l.metric.replace(".", "_") as "agent_runs"}`)}</Td>
                    <Td className="ltr-value font-mono text-xs">{l.dimension || "—"}</Td>
                    <Td className="tabular-nums">{n(l.quantity)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="text-muted mt-3 text-xs">{t("noPrices")}</p>
        </Card>
      </div>
    </>
  );
}
