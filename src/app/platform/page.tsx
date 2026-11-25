import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";
import { Badge, Card, EmptyState, Table, Td, Th } from "@/components/ui/primitives";
import {
  listBillingOrganizations,
  listPlans,
  listStatements,
  platformOperator,
} from "@/modules/billing/platform";
import type { MetricPricing, StatementLine } from "@/modules/billing/rules";
import { USAGE_METRICS } from "@/modules/usage/rules";
import {
  archivePlanAction,
  assignPlanAction,
  generateStatementsAction,
  issueStatementAction,
  savePlanAction,
} from "./actions";

export const dynamic = "force-dynamic";

const lastMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};

/**
 * The platform operator's console (ADR-147): plans and prices entered here
 * (none is preset), the plan of each organization, and monthly statements
 * from metered usage, issued once checked.
 */
export default async function PlatformPage({ searchParams }: PageProps<"/platform">) {
  const sp = await searchParams;
  const who = await platformOperator();
  if (!who) redirect("/sign-in?next=/platform");
  const t = await getTranslations("platform");
  if (!who.ok) {
    if (who.reason === "NOT_LISTED") notFound();
    return (
      <main className="mx-auto w-full max-w-xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p role="alert" className="text-danger">
          {t("needsTwoFactor")}
        </p>
        <Link href="/account/security" className="text-primary hover:underline">
          {t("toSecurity")}
        </Link>
      </main>
    );
  }
  const month =
    typeof sp.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month)
      ? sp.month
      : lastMonth();
  const [format, plans, orgs, statements] = await Promise.all([
    getFormatter(),
    listPlans(who.operator),
    listBillingOrganizations(who.operator),
    listStatements(who.operator, month),
  ]);
  const active = plans.filter((p) => !p.archivedAt);
  const metric = (m: string) => t(`metrics.${m.replace(".", "_") as "agent_runs"}`);
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted text-sm">{t("intro", { email: who.operator.email })}</p>
      </header>

      <Card title={t("plansTitle")}>
        {plans.length === 0 ? (
          <EmptyState title={t("noPlans")} />
        ) : (
          <Table label={t("plansTitle")}>
            <thead>
              <tr>
                <Th>{t("code")}</Th>
                <Th>{t("name")}</Th>
                <Th>{t("monthlyFee")}</Th>
                <Th>{t("pricing")}</Th>
                <Th>{t("organizations")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody data-testid="plans">
              {plans.map((p) => {
                const pricing = p.pricing as Partial<Record<string, MetricPricing>>;
                return (
                  <tr key={p.id}>
                    <Td className="ltr-value font-mono text-xs">{p.code}</Td>
                    <Td>
                      {p.name} {p.archivedAt ? <Badge tone="muted">{t("archived")}</Badge> : null}
                    </Td>
                    <Td className="ltr-value tabular-nums">
                      {p.monthlyFee.toString()} {p.currency}
                    </Td>
                    <Td className="text-xs">
                      {Object.entries(pricing).map(([m, x]) =>
                        x ? (
                          <div key={m}>
                            {metric(m)}:{" "}
                            <span className="ltr-value">
                              {t("priceLine", {
                                included: x.included,
                                price: x.unitPrice,
                                per: x.per,
                              })}
                            </span>
                          </div>
                        ) : null,
                      )}
                    </Td>
                    <Td className="tabular-nums">{p._count.organizations}</Td>
                    <Td>
                      {!p.archivedAt && p._count.organizations === 0 ? (
                        <ConfirmActionButton
                          action={archivePlanAction.bind(null, p.id)}
                          label={t("archive")}
                          variant="secondary"
                        />
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <h3 className="mt-6 mb-2 font-medium">{t("planForm")}</h3>
        <ActionForm action={savePlanAction} submitLabel={t("savePlan")} pendingLabel={t("saving")}>
          <p className="text-muted text-xs">{t("planHint")}</p>
          <div className="grid gap-4 sm:grid-cols-4">
            <TextField name="code" label={t("code")} required dir="ltr" />
            <TextField name="name" label={t("name")} required />
            <TextField name="currency" label={t("currency")} required dir="ltr" />
            <TextField
              name="monthlyFee"
              label={t("monthlyFee")}
              required
              inputMode="decimal"
              dir="ltr"
            />
          </div>
          <div className="space-y-2">
            {USAGE_METRICS.map((m) => {
              const f = m.replace(".", "_");
              return (
                <fieldset key={m} className="grid gap-3 sm:grid-cols-4">
                  <legend className="text-sm font-medium sm:col-span-4">{metric(m)}</legend>
                  <TextField
                    name={`included_${f}`}
                    label={t("included")}
                    inputMode="numeric"
                    dir="ltr"
                  />
                  <TextField
                    name={`price_${f}`}
                    label={t("unitPrice")}
                    inputMode="decimal"
                    dir="ltr"
                  />
                  <SelectField
                    name={`per_${f}`}
                    label={t("per")}
                    options={[
                      { value: "1", label: "1" },
                      { value: "1000", label: "1,000" },
                      { value: "1000000", label: "1,000,000" },
                    ]}
                    defaultValue={m.startsWith("ai.") ? "1000000" : "1"}
                  />
                </fieldset>
              );
            })}
          </div>
        </ActionForm>
      </Card>

      <Card title={t("orgsTitle")}>
        <Table label={t("orgsTitle")}>
          <thead>
            <tr>
              <Th>{t("organization")}</Th>
              <Th>{t("plan")}</Th>
            </tr>
          </thead>
          <tbody data-testid="billing-orgs">
            {orgs.map((o) => (
              <tr key={o.id}>
                <Td>
                  {o.name} <span className="ltr-value text-muted font-mono text-xs">{o.slug}</span>
                </Td>
                <Td>
                  <ActionForm
                    action={assignPlanAction.bind(null, o.id)}
                    submitLabel={t("assign")}
                    pendingLabel={t("saving")}
                    submitVariant="secondary"
                    className="flex flex-wrap items-end gap-2"
                  >
                    <SelectField
                      name="planId"
                      label={t("plan")}
                      options={[
                        { value: "", label: t("noPlan") },
                        ...active.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })),
                      ]}
                      defaultValue={o.billingPlan?.id ?? ""}
                    />
                  </ActionForm>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card title={t("statementsTitle", { month })}>
        <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
          <form className="flex items-end gap-2">
            <TextField name="month" label={t("month")} defaultValue={month} dir="ltr" />
            <button type="submit" className="text-primary hover:underline">
              {t("show")}
            </button>
          </form>
          <ActionForm
            action={generateStatementsAction.bind(null, month)}
            submitLabel={t("generate")}
            pendingLabel={t("saving")}
            submitVariant="secondary"
          >
            <span />
          </ActionForm>
        </div>
        {statements.length === 0 ? (
          <EmptyState title={t("noStatements")} />
        ) : (
          <div className="space-y-4" data-testid="statements">
            {statements.map((s) => (
              <div key={s.id} className="border-border rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {s.organization.name} ·{" "}
                    <span className="ltr-value tabular-nums">
                      {s.total.toString()} {s.currency}
                    </span>{" "}
                    <Badge tone={s.status === "ISSUED" ? "success" : "warning"}>
                      {t(`status.${s.status as "DRAFT"}`)}
                    </Badge>
                  </span>
                  {s.status === "DRAFT" ? (
                    <ConfirmActionButton
                      action={issueStatementAction.bind(null, s.id)}
                      label={t("issue")}
                      confirmMessage={t("issueConfirm")}
                      variant="primary"
                    />
                  ) : (
                    <span className="text-muted text-xs">
                      {t("issuedBy", {
                        who: s.issuedBy ?? "",
                        when: s.issuedAt
                          ? format.dateTime(s.issuedAt, { dateStyle: "medium", timeStyle: "short" })
                          : "",
                      })}
                    </span>
                  )}
                </div>
                <StatementLines
                  lines={s.lines as unknown as StatementLine[]}
                  metric={metric}
                  t={t}
                />
              </div>
            ))}
          </div>
        )}
      </Card>
    </main>
  );
}

function StatementLines({
  lines,
  metric,
  t,
}: {
  lines: StatementLine[];
  metric: (m: string) => string;
  t: Awaited<ReturnType<typeof getTranslations<"platform">>>;
}) {
  return (
    <Table label={t("lines")}>
      <thead>
        <tr>
          <Th>{t("item")}</Th>
          <Th>{t("used")}</Th>
          <Th>{t("included")}</Th>
          <Th>{t("billable")}</Th>
          <Th>{t("unitPrice")}</Th>
          <Th>{t("amount")}</Th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <Td>{l.kind === "FEE" ? t("fee") : metric(l.metric ?? "")}</Td>
            <Td className="tabular-nums">{l.kind === "FEE" ? "" : l.used}</Td>
            <Td className="tabular-nums">{l.kind === "FEE" ? "" : l.included}</Td>
            <Td className="tabular-nums">{l.kind === "FEE" ? "" : l.billable}</Td>
            <Td className="ltr-value tabular-nums">
              {l.kind === "FEE" ? "" : t("perUnits", { price: l.unitPrice, per: l.per })}
            </Td>
            <Td className="ltr-value tabular-nums">{l.amount}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
