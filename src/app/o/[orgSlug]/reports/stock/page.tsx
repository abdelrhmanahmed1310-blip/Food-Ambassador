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
import { canSeeStockHealth, stockHealth } from "@/modules/analytics/stock";
import { AGE_BUCKETS } from "@/modules/analytics/stock-rules";
import { listCompanies } from "@/modules/organizations/companies";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter, productName, quantityFormatter } from "@/server/inventory-view";
import { reportPeriod } from "@/server/report-period";

const BUCKETS = [...AGE_BUCKETS.map((b) => b.key), "UNKNOWN"] as const;

/** Stock ageing (now), turnover and days on hand (over the period) (ADR-106). */
export default async function StockHealthPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/reports/stock">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeStockHealth(ctx)) notFound();
  const period = reportPeriod(sp, ctx.timeZone);
  const company = typeof sp.company === "string" && isUuid(sp.company) ? sp.company : "";
  const [t, locale, r, companies, fmt] = await Promise.all([
    getTranslations(),
    getLocale(),
    stockHealth(ctx, period, { companyId: company || undefined }),
    listCompanies(ctx),
    quantityFormatter(),
  ]);
  const money = await moneyFormatter(r.currency);
  const m = (v: Decimal | null) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>
    );
  const n = (v: Decimal | null, digits = 1) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value tabular-nums">{v.toFixed(digits)}</span>
    );
  const query = `from=${period.from}&to=${period.to}${company ? `&company=${company}` : ""}`;
  return (
    <>
      <PageHeader
        title={t("stockHealth.title")}
        description={t("stockHealth.hint")}
        actions={
          <span className="flex flex-wrap gap-2">
            <a
              href={`/o/${orgSlug}/reports/stock/export?${query}`}
              className={buttonClass("secondary")}
            >
              {t("reports.downloadCsv")}
            </a>
            <a
              href={`/o/${orgSlug}/reports/stock/export?${query}&format=xlsx`}
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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="stock-totals">
          {[
            { label: t("stockHealth.valueNow"), value: m(r.total.onHandValue) },
            { label: t("stockHealth.expired"), value: m(r.total.expiredValue) },
            { label: t("stockHealth.used"), value: m(r.total.usage) },
            { label: t("stockHealth.writtenOff"), value: m(r.total.writtenOff) },
            { label: t("stockHealth.turnover"), value: n(r.total.turnover, 2) },
            { label: t("stockHealth.daysOnHand"), value: n(r.total.daysOnHand) },
            { label: t("stockHealth.closing"), value: m(r.total.closing) },
            {
              label: t("stockHealth.slowMovers"),
              value: <span className="ltr-value">{r.slowMovers}</span>,
            },
          ].map((k) => (
            <div key={k.label} className="border-border bg-surface rounded-xl border p-4 shadow-sm">
              <p className="text-muted text-xs font-medium">{k.label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{k.value}</p>
            </div>
          ))}
        </div>
        <p className="text-muted text-xs">
          {t("stockHealth.basis", { currency: r.currency, today: r.today, days: r.days })}
        </p>

        <Card title={t("stockHealth.ageing")}>
          <Table label={t("stockHealth.ageing")}>
            <thead>
              <tr>
                <Th>{t("stockHealth.warehouse")}</Th>
                {BUCKETS.map((b) => (
                  <Th key={b}>{t(`stockHealth.buckets.${b}`)}</Th>
                ))}
                <Th>{t("stockHealth.valueNow")}</Th>
                <Th>{t("stockHealth.turnover")}</Th>
                <Th>{t("stockHealth.daysOnHand")}</Th>
              </tr>
            </thead>
            <tbody>
              {r.warehouses.map((w) => (
                <tr key={w.warehouse.id}>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{w.warehouse.code}</span>
                    <span className="block">{w.warehouse.name}</span>
                  </Td>
                  {BUCKETS.map((b) => (
                    <Td key={b} className="tabular-nums">
                      {w.buckets[b].isZero() ? (
                        <span className="text-muted">—</span>
                      ) : (
                        m(w.buckets[b])
                      )}
                    </Td>
                  ))}
                  <Td className="font-medium tabular-nums">{m(w.onHandValue)}</Td>
                  <Td>{n(w.turnover, 2)}</Td>
                  <Td>{n(w.daysOnHand)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title={t("stockHealth.products")}>
          {r.products.length === 0 ? (
            <EmptyState title={t("stockHealth.empty")} />
          ) : (
            <Table label={t("stockHealth.products")}>
              <thead>
                <tr>
                  <Th>{t("stockHealth.product")}</Th>
                  <Th>{t("stockHealth.onHand")}</Th>
                  <Th>{t("stockHealth.valueNow")}</Th>
                  <Th>{t("stockHealth.oldest")}</Th>
                  <Th>{t("stockHealth.used")}</Th>
                  <Th>{t("stockHealth.turnover")}</Th>
                  <Th>{t("stockHealth.daysOnHand")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.products.map((p) => (
                  <tr key={`${p.warehouse.id}-${p.product.id}`}>
                    <Td>
                      {p.product.sku} — {productName(p.product, locale)}
                      <span className="ltr-value text-muted block font-mono text-xs">
                        {p.warehouse.code}
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {p.slowMover ? <Badge tone="warning">{t("stockHealth.slow")}</Badge> : null}
                        {p.expiredValue.gt(0) ? (
                          <Badge tone="danger">{t("stockHealth.hasExpired")}</Badge>
                        ) : null}
                        {p.costMissing ? (
                          <Badge tone="muted">{t("stockHealth.costMissing")}</Badge>
                        ) : null}
                      </span>
                    </Td>
                    <Td className="ltr-value tabular-nums">{`${fmt(p.quantity)} ${p.product.baseUom.code}`}</Td>
                    <Td className="tabular-nums">{m(p.onHandValue)}</Td>
                    <Td className="ltr-value tabular-nums">
                      {p.oldestAgeDays === null
                        ? "—"
                        : t("stockHealth.daysValue", { days: p.oldestAgeDays })}
                    </Td>
                    <Td className="tabular-nums">{m(p.usage)}</Td>
                    <Td>{n(p.turnover, 2)}</Td>
                    <Td>{n(p.daysOnHand)}</Td>
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
