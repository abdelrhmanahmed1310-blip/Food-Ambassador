import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CompanySelect } from "@/components/reports/company-select";
import { PeriodForm } from "@/components/reports/period-form";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { listCompanies } from "@/modules/organizations/companies";
import { canSeeSpend, spendReport } from "@/modules/procurement/spend";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { reportPeriod } from "@/server/report-period";

export default async function SpendReportPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/reports/spend">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeSpend(ctx)) notFound();
  const period = reportPeriod(sp, ctx.timeZone);
  const company = typeof sp.company === "string" && isUuid(sp.company) ? sp.company : "";
  const [t, locale, r, companies] = await Promise.all([
    getTranslations(),
    getLocale(),
    spendReport(ctx, period, company || undefined),
    listCompanies(ctx),
  ]);
  const money = await moneyFormatter(r.currency);
  const m = (v: Decimal) => <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>;
  const pct = (v: Decimal | null) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value">{v.times(100).toFixed(1)} %</span>
    );
  const query = `from=${period.from}&to=${period.to}${company ? `&company=${company}` : ""}`;
  const name = (x: { name: string; nameAr?: string | null }) =>
    (locale === "ar" && x.nameAr) || x.name;
  return (
    <>
      <PageHeader
        title={t("spend.title")}
        description={t("spend.hint")}
        actions={
          <span className="flex flex-wrap gap-2">
            <a
              href={`/o/${orgSlug}/reports/spend/export?${query}`}
              className={buttonClass("secondary")}
            >
              {t("reports.downloadCsv")}
            </a>
            <a
              href={`/o/${orgSlug}/reports/spend/export?${query}&format=xlsx`}
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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="spend-totals">
          {[
            { label: t("spend.received"), value: m(r.total.received) },
            { label: t("spend.returned"), value: m(r.total.returned) },
            { label: t("spend.net"), value: m(r.total.net) },
            { label: t("spend.top5Share"), value: pct(r.top5Share) },
          ].map((k) => (
            <div key={k.label} className="border-border bg-surface rounded-xl border p-4 shadow-sm">
              <p className="text-muted text-xs font-medium">{k.label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{k.value}</p>
            </div>
          ))}
        </div>
        <p className="text-muted text-xs">{t("spend.basis", { currency: r.currency })}</p>

        <Card title={t("spend.bySupplier")}>
          {r.suppliers.length === 0 ? (
            <EmptyState title={t("spend.empty")} />
          ) : (
            <Table label={t("spend.bySupplier")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.supplier")}</Th>
                  <Th>{t("spend.received")}</Th>
                  <Th>{t("spend.returned")}</Th>
                  <Th>{t("spend.net")}</Th>
                  <Th>{t("spend.share")}</Th>
                  <Th>{t("spend.lines")}</Th>
                  <Th>{t("spend.variance")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.suppliers.map((s) => (
                  <tr key={s.key}>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/suppliers/${s.key}`}
                        className="text-primary hover:underline"
                      >
                        {name(s.supplier)}
                      </Link>
                      <span className="ltr-value text-muted block font-mono text-xs">
                        {s.supplier.code}
                      </span>
                    </Td>
                    <Td className="tabular-nums">{m(s.received)}</Td>
                    <Td className="tabular-nums">{m(s.returned)}</Td>
                    <Td className="font-medium tabular-nums">{m(s.net)}</Td>
                    <Td className="tabular-nums">{pct(s.share)}</Td>
                    <Td className="tabular-nums">{s.lines}</Td>
                    <Td className="tabular-nums">{m(s.variance)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title={t("spend.byCategory")}>
          <p className="text-muted mb-3 text-xs">{t("spend.singleSourceHint")}</p>
          {r.categories.length === 0 ? (
            <EmptyState title={t("spend.empty")} />
          ) : (
            <Table label={t("spend.byCategory")}>
              <thead>
                <tr>
                  <Th>{t("spend.category")}</Th>
                  <Th>{t("spend.net")}</Th>
                  <Th>{t("spend.share")}</Th>
                  <Th>{t("spend.suppliers")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.categories.map((c) => (
                  <tr key={c.key ?? "none"}>
                    <Td>
                      {c.category ? (
                        name(c.category)
                      ) : (
                        <span className="text-muted">{t("spend.noCategory")}</span>
                      )}
                      {c.singleSource ? (
                        <span className="ms-2">
                          <Badge tone="warning">{t("spend.singleSource")}</Badge>
                        </span>
                      ) : null}
                    </Td>
                    <Td className="tabular-nums">{m(c.net)}</Td>
                    <Td className="tabular-nums">{pct(c.share)}</Td>
                    <Td className="tabular-nums">{c.suppliers}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title={t("spend.byBranch")}>
            {r.branches.length === 0 ? (
              <EmptyState title={t("spend.empty")} />
            ) : (
              <Table label={t("spend.byBranch")}>
                <thead>
                  <tr>
                    <Th>{t("spend.branch")}</Th>
                    <Th>{t("spend.net")}</Th>
                    <Th>{t("spend.share")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.branches.map((b) => (
                    <tr key={b.key}>
                      <Td>
                        <span className="ltr-value font-mono text-xs">{b.branch.code}</span>{" "}
                        {b.branch.name}
                      </Td>
                      <Td className="tabular-nums">{m(b.net)}</Td>
                      <Td className="tabular-nums">{pct(b.share)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title={t("spend.byMonth")}>
            {r.months.length === 0 ? (
              <EmptyState title={t("spend.empty")} />
            ) : (
              <Table label={t("spend.byMonth")}>
                <thead>
                  <tr>
                    <Th>{t("spend.month")}</Th>
                    <Th>{t("spend.received")}</Th>
                    <Th>{t("spend.net")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.months.map((mo) => (
                    <tr key={mo.key}>
                      <Td>
                        <span className="ltr-value">{mo.key}</span>
                      </Td>
                      <Td className="tabular-nums">{m(mo.received)}</Td>
                      <Td className="tabular-nums">{m(mo.net)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
