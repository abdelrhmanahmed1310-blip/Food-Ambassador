import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EndRuleForm, EosRuleForm, RuleForm, TaxTableForm } from "@/components/payroll/forms";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import {
  canViewPayroll,
  listContributionRules,
  listTaxAndEosRules,
} from "@/modules/payroll/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  addEosRuleAction,
  addRuleAction,
  addTaxTableAction,
  endRuleAction,
  endTaxOrEosAction,
} from "../actions";

/** Contribution rules entered per company, dated (ADR-123, Q-20). */
export default async function PayrollRulesPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/payroll/rules">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewPayroll(ctx)) notFound();
  const [t, data, more] = await Promise.all([
    getTranslations("payroll"),
    listContributionRules(ctx),
    listTaxAndEosRules(ctx),
  ]);
  const companies = data.companies.map((c) => ({
    value: c.id,
    label: `${c.code} — ${c.name}${c.country ? ` (${c.country})` : ""}`,
  }));
  const range = (r: { effectiveFrom: string; effectiveTo: string | null }) =>
    `${r.effectiveFrom} → ${r.effectiveTo ?? "…"}`;
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
        <h2 className="text-lg font-semibold">{t("taxTables")}</h2>
        {more.tax.length === 0 ? (
          <EmptyState title={t("noTaxTables")} />
        ) : (
          <Table label={t("taxTables")}>
            <thead>
              <tr>
                <Th>{t("company")}</Th>
                <Th>{t("ruleCode")}</Th>
                <Th>{t("appliesTo")}</Th>
                <Th>{t("brackets")}</Th>
                <Th>{t("effective")}</Th>
                <Th>{t("source")}</Th>
                {data.canManage ? <Th>{t("actions")}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {more.tax.map((r) => (
                <tr key={r.id} data-testid={`tax-${r.code}`}>
                  <Td>{r.company.code}</Td>
                  <Td>
                    <span className="ltr-value font-mono">{r.code}</span>
                    <span className="text-muted block text-xs">
                      {r.name} ·{" "}
                      {t("exemptionShort", { amount: r.input.annualExemption.toFixed() })}
                      {r.deductContributions ? ` · ${t("afterContributions")}` : ""}
                    </span>
                  </Td>
                  <Td>{t(`applies.${r.appliesTo}`)}</Td>
                  <Td className="ltr-value text-sm">
                    {r.input.bands.map((b, i) => (
                      <span key={i} className="block">
                        {r.input.bands.length > 1 ? `≤ ${b.upTo?.toFixed() ?? "∞"}: ` : ""}
                        {b.brackets
                          .map(
                            (x) => `${x.rate.times(100).toFixed()}% ≤ ${x.upTo?.toFixed() ?? "∞"}`,
                          )
                          .join(" · ")}
                      </span>
                    ))}
                  </Td>
                  <Td className="ltr-value whitespace-nowrap">{range(r)}</Td>
                  <Td className="text-sm">{r.source}</Td>
                  {data.canManage ? (
                    <Td>
                      {r.effectiveTo ? null : (
                        <EndRuleForm action={endTaxOrEosAction.bind(null, orgSlug, "tax", r.id)} />
                      )}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <h2 className="text-lg font-semibold">{t("eosRules")}</h2>
        {more.eos.length === 0 ? (
          <EmptyState title={t("noEosRules")} />
        ) : (
          <Table label={t("eosRules")}>
            <thead>
              <tr>
                <Th>{t("company")}</Th>
                <Th>{t("ruleCode")}</Th>
                <Th>{t("appliesTo")}</Th>
                <Th>{t("tiers")}</Th>
                <Th>{t("resignation")}</Th>
                <Th>{t("effective")}</Th>
                <Th>{t("source")}</Th>
                {data.canManage ? <Th>{t("actions")}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {more.eos.map((r) => (
                <tr key={r.id} data-testid={`eos-${r.code}`}>
                  <Td>{r.company.code}</Td>
                  <Td>
                    <span className="ltr-value font-mono">{r.code}</span>
                    <span className="text-muted block text-xs">
                      {r.name} · {t(`eosBases.${r.base}`)}
                      {r.input.capMonths
                        ? ` · ${t("capShort", { months: r.input.capMonths.toFixed() })}`
                        : ""}
                    </span>
                  </Td>
                  <Td>{t(`applies.${r.appliesTo}`)}</Td>
                  <Td className="ltr-value text-sm">
                    {r.input.tiers
                      .map((x) =>
                        t("tierShort", {
                          from: x.fromYears.toFixed(),
                          months: x.monthsPerYear.toFixed(),
                        }),
                      )
                      .join(" · ")}
                  </Td>
                  <Td className="ltr-value text-sm">
                    {r.input.resignation.length === 0
                      ? t("resignationFull")
                      : r.input.resignation
                          .map((x) =>
                            t("shareShort", {
                              from: x.fromYears.toFixed(),
                              share: x.factor.times(100).toFixed(),
                            }),
                          )
                          .join(" · ")}
                  </Td>
                  <Td className="ltr-value whitespace-nowrap">{range(r)}</Td>
                  <Td className="text-sm">{r.source}</Td>
                  {data.canManage ? (
                    <Td>
                      {r.effectiveTo ? null : (
                        <EndRuleForm action={endTaxOrEosAction.bind(null, orgSlug, "eos", r.id)} />
                      )}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data.canManage ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title={t("addTaxTable")}>
              <TaxTableForm action={addTaxTableAction.bind(null, orgSlug)} companies={companies} />
            </Card>
            <Card title={t("addEosRule")}>
              <EosRuleForm action={addEosRuleAction.bind(null, orgSlug)} companies={companies} />
            </Card>
          </div>
        ) : null}
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
