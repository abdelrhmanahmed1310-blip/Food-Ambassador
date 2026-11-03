import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CompanySelect } from "@/components/reports/company-select";
import { PeriodForm } from "@/components/reports/period-form";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { listCompanies } from "@/modules/organizations/companies";
import { canSeeSpend, priceVarianceReport } from "@/modules/procurement/spend";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyIn } from "@/server/fx-view";
import { quantityFormatter } from "@/server/inventory-view";
import { reportPeriod } from "@/server/report-period";

export default async function PriceVariancePage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/reports/price-variance">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeSpend(ctx)) notFound();
  const period = reportPeriod(sp, ctx.timeZone);
  const company = typeof sp.company === "string" && isUuid(sp.company) ? sp.company : "";
  const [t, locale, r, companies, qty] = await Promise.all([
    getTranslations(),
    getLocale(),
    priceVarianceReport(ctx, period, company || undefined),
    listCompanies(ctx),
    quantityFormatter(),
  ]);
  const moneyOf = await moneyIn([r.currency, ...r.lines.map((l) => l.currency)]);
  const money = moneyOf(r.currency);
  const m = (v: Decimal) => (
    <span
      className={`ltr-value whitespace-nowrap ${v.greaterThan(0) ? "text-danger" : v.lessThan(0) ? "text-success" : ""}`}
    >
      {money.money(v)}
    </span>
  );
  const pct = (v: Decimal | null) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value">{v.times(100).toFixed(1)} %</span>
    );
  const query = `from=${period.from}&to=${period.to}${company ? `&company=${company}` : ""}`;
  const name = (x: { name: string; nameAr?: string | null }) =>
    (locale === "ar" && x.nameAr) || x.name;
  const product = (p: { sku: string; nameEn: string; nameAr: string | null }) => (
    <>
      {(locale === "ar" && p.nameAr) || p.nameEn}
      <span className="ltr-value text-muted block font-mono text-xs">{p.sku}</span>
    </>
  );
  return (
    <>
      <PageHeader
        title={t("ppv.title")}
        description={t("ppv.hint")}
        actions={
          <span className="flex flex-wrap gap-2">
            <a
              href={`/o/${orgSlug}/reports/price-variance/export?${query}`}
              className={buttonClass("secondary")}
            >
              {t("reports.downloadCsv")}
            </a>
            <a
              href={`/o/${orgSlug}/reports/price-variance/export?${query}&format=xlsx`}
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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="ppv-totals">
          {[
            { label: t("ppv.unfavourable"), value: m(r.total.unfavourable) },
            { label: t("ppv.favourable"), value: m(r.total.favourable) },
            { label: t("ppv.net"), value: m(r.total.net) },
            {
              label: t("ppv.linesWithVariance"),
              value: (
                <span className="tabular-nums">
                  {r.total.linesWithVariance} / {r.total.lines}
                </span>
              ),
            },
          ].map((k) => (
            <div key={k.label} className="border-border bg-surface rounded-xl border p-4 shadow-sm">
              <p className="text-muted text-xs font-medium">{k.label}</p>
              <p className="mt-1 text-lg font-semibold">{k.value}</p>
            </div>
          ))}
        </div>
        <p className="text-muted text-xs">{t("ppv.basis", { currency: r.currency })}</p>

        <Card title={t("ppv.bySupplier")}>
          {r.suppliers.length === 0 ? (
            <EmptyState title={t("spend.empty")} />
          ) : (
            <Table label={t("ppv.bySupplier")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.supplier")}</Th>
                  <Th>{t("spend.received")}</Th>
                  <Th>{t("ppv.variance")}</Th>
                  <Th>{t("ppv.rate")}</Th>
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
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">{money.money(s.received)}</span>
                    </Td>
                    <Td className="tabular-nums">{m(s.variance)}</Td>
                    <Td className="tabular-nums">{pct(s.rate)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title={t("ppv.linesTitle")}>
          <p className="text-muted mb-3 text-xs">{t("ppv.linesHint")}</p>
          {r.lines.length === 0 ? (
            <EmptyState title={t("ppv.noLines")} />
          ) : (
            <Table label={t("ppv.linesTitle")}>
              <thead>
                <tr>
                  <Th>{t("ppv.receipt")}</Th>
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("common.quantity")}</Th>
                  <Th>{t("ppv.ordered")}</Th>
                  <Th>{t("ppv.charged")}</Th>
                  <Th>{t("ppv.variance")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.lineId}>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/purchasing/receipts/${l.receiptId}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {l.receiptNumber}
                      </Link>
                      <span className="text-muted block text-xs">
                        <span className="ltr-value">{l.receivedOn}</span> · {l.supplier.code}
                      </span>
                    </Td>
                    <Td>{product(l.product)}</Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {qty(l.acceptedQuantity)} {l.uom}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {moneyOf(l.currency).unitCost(l.orderedUnitPrice)}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {moneyOf(l.currency).unitCost(l.unitPrice)}
                      </span>
                    </Td>
                    <Td className="tabular-nums">{m(l.variance)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title={t("ppv.changesTitle")}>
          <p className="text-muted mb-3 text-xs">
            {t("ppv.changesHint", { from: r.previous.from, to: r.previous.to })}
          </p>
          {r.changes.length === 0 ? (
            <EmptyState title={t("ppv.noChanges")} />
          ) : (
            <Table label={t("ppv.changesTitle")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("ppv.before")}</Th>
                  <Th>{t("ppv.now")}</Th>
                  <Th>{t("ppv.change")}</Th>
                  <Th>{t("ppv.impact")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.changes.map((c) => (
                  <tr key={c.productId}>
                    <Td>{product(c.product)}</Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {money.unitCost(c.before)} / {c.product.baseUom.code}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {money.unitCost(c.now)} / {c.product.baseUom.code}
                      </span>
                    </Td>
                    <Td className="tabular-nums">{pct(c.change)}</Td>
                    <Td className="tabular-nums">{m(c.impact)}</Td>
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
