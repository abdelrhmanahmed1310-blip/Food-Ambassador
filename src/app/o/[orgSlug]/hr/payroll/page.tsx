import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { NewRunForm, ProrationForm } from "@/components/payroll/forms";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { canViewPayroll, listPayrollRuns } from "@/modules/payroll/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyIn } from "@/server/fx-view";
import { createRunAction, setProrationAction } from "./actions";
import { STATUS_TONE } from "./status";

/** Payroll runs per company and month (ADR-123). */
export default async function PayrollPage({ params }: PageProps<"/o/[orgSlug]/hr/payroll">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewPayroll(ctx)) notFound();
  const [t, data] = await Promise.all([getTranslations("payroll"), listPayrollRuns(ctx)]);
  const moneyOf = await moneyIn(data.runs.map((r) => r.currency));
  const base = `/o/${orgSlug}/hr/payroll`;
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("hint")}
        actions={
          <LinkButton href={`${base}/rules`} variant="secondary">
            {t("rules")}
          </LinkButton>
        }
      />
      <div className="space-y-6">
        <Alert tone="info">{t("noPresets")}</Alert>
        {data.runs.length === 0 ? (
          <EmptyState title={t("noRuns")} />
        ) : (
          <Table label={t("title")}>
            <thead>
              <tr>
                <Th>{t("number")}</Th>
                <Th>{t("period")}</Th>
                <Th>{t("company")}</Th>
                <Th>{t("employees")}</Th>
                <Th>{t("net")}</Th>
                <Th>{t("employerCost")}</Th>
                <Th>{t("status")}</Th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Link
                      href={`${base}/${r.id}`}
                      className="text-primary ltr-value font-mono hover:underline"
                    >
                      {r.number}
                    </Link>
                  </Td>
                  <Td className="ltr-value">{r.period.toISOString().slice(0, 7)}</Td>
                  <Td>
                    {r.company.code} — {r.company.name}
                  </Td>
                  <Td className="tabular-nums">{r._count.lines}</Td>
                  <Td className="ltr-value tabular-nums">{moneyOf(r.currency).money(r.net)}</Td>
                  <Td className="ltr-value tabular-nums">
                    {moneyOf(r.currency).money(r.employerCost)}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[r.status]}>{t(`statuses.${r.status}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data.canManage ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title={t("newRun")}>
              {data.prorationBasis ? (
                <NewRunForm
                  action={createRunAction.bind(null, orgSlug)}
                  companies={data.companies.map((c) => ({
                    value: c.id,
                    label: `${c.code} — ${c.name}`,
                  }))}
                />
              ) : (
                <p className="text-muted text-sm">{t("chooseBasisFirst")}</p>
              )}
            </Card>
            <Card title={t("settings")}>
              <ProrationForm
                action={setProrationAction.bind(null, orgSlug)}
                current={data.prorationBasis}
              />
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
