import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { PeriodForm } from "@/components/reports/period-form";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { canSeeReports, wasteReport } from "@/modules/analytics/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter, productName, quantityFormatter } from "@/server/inventory-view";
import { reportPeriod } from "@/server/report-period";

export default async function WasteReportPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/reports/waste">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeReports(ctx).waste) notFound();
  const period = reportPeriod(sp, ctx.timeZone);
  const warehouseId =
    typeof sp.warehouseId === "string" && isUuid(sp.warehouseId) ? sp.warehouseId : undefined;
  const [t, locale, money, fmt, r] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
    quantityFormatter(),
    wasteReport(ctx, period, { warehouseId }),
  ]);
  const reason = (code: string) =>
    code === ""
      ? "—"
      : t.has(`inventory.reasons.${code}`)
        ? t(`inventory.reasons.${code as "OTHER"}`)
        : code;
  const amount = (v: { toString(): string }) => (
    <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>
  );
  return (
    <>
      <PageHeader
        title={t("reports.wasteTitle")}
        description={t("reports.wasteHint")}
        actions={
          <a
            href={`/o/${orgSlug}/reports/waste/export?from=${period.from}&to=${period.to}`}
            className={buttonClass("secondary")}
          >
            {t("reports.downloadCsv")}
          </a>
        }
      />
      <div className="space-y-6">
        <PeriodForm from={period.from} to={period.to}>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("common.warehouse")}</span>
            <select
              name="warehouseId"
              defaultValue={warehouseId ?? ""}
              className="border-border bg-surface rounded-md border px-3 py-2"
            >
              <option value="">{t("reports.allWarehouses")}</option>
              {r.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
          </label>
        </PeriodForm>
        {r.costMissing ? <Alert tone="info">{t("reports.costMissing")}</Alert> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Card title={t("reports.waste")}>
            <p className="text-2xl font-semibold tabular-nums" data-testid="waste-total">
              {amount(r.total.WASTE)}
            </p>
            <p className="text-muted text-xs">{t("reports.wasteNote")}</p>
          </Card>
          <Card title={t("reports.differences")}>
            <p className="text-2xl font-semibold tabular-nums" data-testid="differences-total">
              {amount(r.total.DIFFERENCE)}
            </p>
            <p className="text-muted text-xs">{t("reports.differencesNote")}</p>
          </Card>
        </div>
        {r.rows.length === 0 ? (
          <EmptyState title={t("reports.noLosses")} />
        ) : (
          <>
            <Card title={t("reports.byReason")}>
              <Table label={t("reports.byReason")}>
                <tbody>
                  {r.byReason.map((b) => (
                    <tr key={`${b.kind}-${b.reason}`}>
                      <Td>{t(`reports.kinds.${b.kind}`)}</Td>
                      <Td>{reason(b.reason)}</Td>
                      <Td className="tabular-nums">{amount(b.value)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Table label={t("reports.wasteTitle")}>
              <thead>
                <tr>
                  <Th>{t("reports.kind")}</Th>
                  <Th>{t("common.warehouse")}</Th>
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("reports.reason")}</Th>
                  <Th>{t("common.quantity")}</Th>
                  <Th>{t("reports.value")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map((row, i) => (
                  <tr key={i}>
                    <Td>{t(`reports.kinds.${row.kind}`)}</Td>
                    <Td>
                      <span className="ltr-value font-mono text-xs">{row.warehouse.code}</span>
                    </Td>
                    <Td>
                      {productName(row.product, locale)}
                      <span className="ltr-value text-muted block font-mono text-xs">
                        {row.product.sku}
                      </span>
                    </Td>
                    <Td>{reason(row.reason)}</Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {fmt(row.quantity)} {row.product.baseUom.code}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      {amount(row.value)}
                      {row.costMissing ? (
                        <span className="text-muted block text-xs">
                          {t("reports.someCostMissing")}
                        </span>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </div>
    </>
  );
}
