import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CompanySelect } from "@/components/reports/company-select";
import { PeriodForm } from "@/components/reports/period-form";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { canSeeSales, salesAnalytics } from "@/modules/analytics/sales";
import { listCompanies } from "@/modules/organizations/companies";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { reportPeriod } from "@/server/report-period";

/** Sales analytics: totals with comparisons, branches against targets, channels, weekdays, hours, days (ADR-105). */
export default async function SalesReportPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/reports/sales">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeSales(ctx)) notFound();
  const period = reportPeriod(sp, ctx.timeZone);
  const company = typeof sp.company === "string" && isUuid(sp.company) ? sp.company : "";
  const [t, r, companies] = await Promise.all([
    getTranslations(),
    salesAnalytics(ctx, period, { companyId: company || undefined }),
    listCompanies(ctx),
  ]);
  const money = await moneyFormatter(r.currency);
  const m = (v: Decimal | null) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>
    );
  const pct = (v: Decimal | null, signed = false) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value">
        {signed && v.gt(0) ? "+" : ""}
        {v.times(100).toFixed(1)} %
      </span>
    );
  const query = `from=${period.from}&to=${period.to}${company ? `&company=${company}` : ""}`;
  const peak = r.hours.reduce((a, h) => (h.net.gt(a) ? h.net : a), r.hours[0]?.net ?? null);
  return (
    <>
      <PageHeader
        title={t("salesReport.title")}
        description={t("salesReport.hint")}
        actions={
          <span className="flex flex-wrap gap-2">
            <Link href={`/o/${orgSlug}/reports/sales/targets`} className={buttonClass("secondary")}>
              {t("salesReport.targets")}
            </Link>
            <a
              href={`/o/${orgSlug}/reports/sales/export?${query}`}
              className={buttonClass("secondary")}
            >
              {t("reports.downloadCsv")}
            </a>
            <a
              href={`/o/${orgSlug}/reports/sales/export?${query}&format=xlsx`}
              className={buttonClass("secondary")}
            >
              {t("common.excel")}
            </a>
          </span>
        }
      />
      <div className="space-y-6">
        <PeriodForm from={period.from} to={period.to}>
          <CompanySelect companies={companies} value={company} />
        </PeriodForm>
        {r.missingRates.length > 0 ? (
          <Alert tone="error">
            {t("fx.missingRates", { currencies: r.missingRates.join(", ") })}
          </Alert>
        ) : null}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="sales-totals">
          {[
            { label: t("salesReport.net"), value: m(r.total.net) },
            {
              label: t("salesReport.orders"),
              value: <span className="ltr-value">{r.total.orders}</span>,
            },
            { label: t("salesReport.averageTicket"), value: m(r.total.averageTicket) },
            { label: t("salesReport.achievement"), value: pct(r.total.achievement) },
            { label: t("salesReport.vsPrevious"), value: pct(r.total.growthPrevious, true) },
            { label: t("salesReport.vsLastYear"), value: pct(r.total.growthLastYear, true) },
            { label: t("salesReport.previousNet"), value: m(r.total.previous.net) },
            { label: t("salesReport.target"), value: m(r.total.target) },
          ].map((k) => (
            <div key={k.label} className="border-border bg-surface rounded-xl border p-4 shadow-sm">
              <p className="text-muted text-xs font-medium">{k.label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{k.value}</p>
            </div>
          ))}
        </div>
        <p className="text-muted text-xs">
          {t("salesReport.basis", {
            currency: r.currency,
            previousFrom: r.previous.from,
            previousTo: r.previous.to,
            yearFrom: r.lastYear.from,
            yearTo: r.lastYear.to,
          })}
        </p>

        <Card title={t("salesReport.byBranch")}>
          {r.branches.length === 0 ? (
            <EmptyState title={t("salesReport.empty")} />
          ) : (
            <Table label={t("salesReport.byBranch")}>
              <thead>
                <tr>
                  <Th>{t("salesReport.branch")}</Th>
                  <Th>{t("salesReport.net")}</Th>
                  <Th>{t("salesReport.orders")}</Th>
                  <Th>{t("salesReport.averageTicket")}</Th>
                  <Th>{t("salesReport.share")}</Th>
                  <Th>{t("salesReport.target")}</Th>
                  <Th>{t("salesReport.achievement")}</Th>
                  <Th>{t("salesReport.vsPrevious")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.branches.map((b) => (
                  <tr key={b.branch.id}>
                    <Td>
                      {b.branch.name}
                      <span className="ltr-value text-muted block font-mono text-xs">
                        {b.branch.code}
                      </span>
                    </Td>
                    <Td className="font-medium tabular-nums">{m(b.net)}</Td>
                    <Td className="ltr-value tabular-nums">{b.orders}</Td>
                    <Td className="tabular-nums">{m(b.averageTicket)}</Td>
                    <Td>{pct(b.share)}</Td>
                    <Td className="tabular-nums">{m(b.target)}</Td>
                    <Td>{pct(b.achievement)}</Td>
                    <Td>{pct(b.growthPrevious, true)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title={t("salesReport.byChannel")}>
            {r.channels.length === 0 ? (
              <EmptyState title={t("salesReport.empty")} />
            ) : (
              <Table label={t("salesReport.byChannel")}>
                <thead>
                  <tr>
                    <Th>{t("salesReport.channel")}</Th>
                    <Th>{t("salesReport.net")}</Th>
                    <Th>{t("salesReport.orders")}</Th>
                    <Th>{t("salesReport.share")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.channels.map((c) => (
                    <tr key={c.channel}>
                      <Td>{t(`salesReport.channels.${c.channel}`)}</Td>
                      <Td className="tabular-nums">{m(c.net)}</Td>
                      <Td className="ltr-value tabular-nums">{c.orders}</Td>
                      <Td>{pct(c.share)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title={t("salesReport.byWeekday")}>
            <Table label={t("salesReport.byWeekday")}>
              <thead>
                <tr>
                  <Th>{t("salesReport.weekday")}</Th>
                  <Th>{t("salesReport.net")}</Th>
                  <Th>{t("salesReport.orders")}</Th>
                  <Th>{t("salesReport.averageTicket")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.weekdays.map((w) => (
                  <tr key={w.weekday}>
                    <Td>{t(`salesReport.weekdays.${w.weekday}`)}</Td>
                    <Td className="tabular-nums">{m(w.net)}</Td>
                    <Td className="ltr-value tabular-nums">{w.orders}</Td>
                    <Td className="tabular-nums">{m(w.averageTicket)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>

        <Card title={t("salesReport.byHour")}>
          <p className="text-muted mb-3 text-xs">{t("salesReport.hourHint")}</p>
          <ul className="space-y-1" data-testid="sales-hours">
            {r.hours
              .filter((h) => h.orders > 0)
              .map((h) => (
                <li key={h.hour} className="flex items-center gap-3 text-sm">
                  <span className="ltr-value w-14 font-mono tabular-nums">
                    {String(h.hour).padStart(2, "0")}:00
                  </span>
                  <span className="bg-surface-muted relative h-4 flex-1 overflow-hidden rounded">
                    <span
                      className="bg-primary absolute inset-y-0 start-0 rounded"
                      style={{
                        width: `${peak && peak.gt(0) ? h.net.div(peak).times(100).toFixed(1) : "0"}%`,
                      }}
                    />
                  </span>
                  <span className="w-32 text-end tabular-nums">{m(h.net)}</span>
                  <span className="ltr-value text-muted w-10 text-end tabular-nums">
                    {h.orders}
                  </span>
                </li>
              ))}
          </ul>
          {r.hours.every((h) => h.orders === 0) ? (
            <EmptyState title={t("salesReport.empty")} />
          ) : null}
        </Card>

        <Card title={t("salesReport.byDay")}>
          {r.days.length === 0 ? (
            <EmptyState title={t("salesReport.empty")} />
          ) : (
            <Table label={t("salesReport.byDay")}>
              <thead>
                <tr>
                  <Th>{t("salesReport.day")}</Th>
                  <Th>{t("salesReport.net")}</Th>
                  <Th>{t("salesReport.orders")}</Th>
                  <Th>{t("salesReport.averageTicket")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.days.map((d) => (
                  <tr key={d.day}>
                    <Td className="ltr-value tabular-nums">{d.day}</Td>
                    <Td className="tabular-nums">{m(d.net)}</Td>
                    <Td className="ltr-value tabular-nums">{d.orders}</Td>
                    <Td className="tabular-nums">{m(d.averageTicket)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
