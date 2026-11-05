import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EndRuleForm, RuleForm } from "@/components/payroll/forms";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { canViewPayroll, listContributionRules } from "@/modules/payroll/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { addRuleAction, endRuleAction } from "../actions";

/** Contribution rules entered per company, dated (ADR-123, Q-20). */
export default async function PayrollRulesPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/payroll/rules">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewPayroll(ctx)) notFound();
  const [t, data] = await Promise.all([getTranslations("payroll"), listContributionRules(ctx)]);
  const pct = (v: { times(n: number): { toString(): string } }) => `${v.times(100).toString()}%`;
  return (
    <>
      <PageHeader title={t("rulesTitle")} description={t("rulesHint")} />
      <div className="space-y-6">
        <Alert tone="info">{t("noPresets")}</Alert>
        {data.rules.length === 0 ? (
          <EmptyState title={t("noRules")} />
        ) : (
          <Table label={t("rulesTitle")}>
            <thead>
              <tr>
                <Th>{t("company")}</Th>
                <Th>{t("ruleCode")}</Th>
                <Th>{t("appliesTo")}</Th>
                <Th>{t("employeeRate")}</Th>
                <Th>{t("employerRate")}</Th>
                <Th>{t("baseLimits")}</Th>
                <Th>{t("effective")}</Th>
                <Th>{t("source")}</Th>
                {data.canManage ? <Th>{t("actions")}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={r.id}>
                  <Td>{r.company.code}</Td>
                  <Td>
                    <span className="ltr-value font-mono">{r.code}</span>
                    <span className="text-muted block text-xs">{r.name}</span>
                  </Td>
                  <Td>{t(`applies.${r.appliesTo}`)}</Td>
                  <Td className="ltr-value tabular-nums">{pct(r.employeeRate)}</Td>
                  <Td className="ltr-value tabular-nums">{pct(r.employerRate)}</Td>
                  <Td className="ltr-value tabular-nums">
                    {r.baseMin ? r.baseMin.toString() : "—"} –{" "}
                    {r.baseMax ? r.baseMax.toString() : "—"} {r.company.currency}
                  </Td>
                  <Td className="ltr-value whitespace-nowrap">
                    {r.effectiveFrom} → {r.effectiveTo ?? "…"}
                  </Td>
                  <Td className="text-sm">{r.source}</Td>
                  {data.canManage ? (
                    <Td>
                      {r.effectiveTo ? null : (
                        <EndRuleForm action={endRuleAction.bind(null, orgSlug, r.id)} />
                      )}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data.canManage ? (
          <Card title={t("addRule")}>
            <RuleForm
              action={addRuleAction.bind(null, orgSlug)}
              companies={data.companies.map((c) => ({
                value: c.id,
                label: `${c.code} — ${c.name}${c.country ? ` (${c.country})` : ""}`,
              }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
