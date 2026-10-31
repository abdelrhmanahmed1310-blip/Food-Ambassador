import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PeriodForm } from "@/components/reports/period-form";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import type { Decimal } from "@/lib/decimal";
import { canSeeReports, foodCostReport, foodCostTrend } from "@/modules/analytics/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { reportPeriod } from "@/server/report-period";

export default async function FoodCostReportPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/reports/food-cost">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeReports(ctx).foodCost) notFound();
  const period = reportPeriod(sp, ctx.timeZone);
  const [t, money, r, trend] = await Promise.all([
    getTranslations(),
    moneyFormatter(ctx.baseCurrency),
    foodCostReport(ctx, period),
    foodCostTrend(ctx, 12),
  ]);
  const amount = (v: Decimal | null) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>
    );
  const pct = (v: Decimal | null) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value">{v.times(100).toFixed(1)} %</span>
    );
  const row = (label: React.ReactNode, f: (typeof r)["total"], testId: string) => (
    <tr data-testid={testId}>
      <Td>{label}</Td>
      <Td className="tabular-nums">{f.imports}</Td>
      <Td className="tabular-nums">{amount(f.net)}</Td>
      <Td className="tabular-nums">{amount(f.cost)}</Td>
      <Td className="font-medium tabular-nums">{pct(f.foodCost)}</Td>
      <Td className="tabular-nums">{amount(f.waste)}</Td>
      <Td className="tabular-nums">{amount(f.differences)}</Td>
      <Td className="font-medium tabular-nums">{pct(f.costWithLosses)}</Td>
    </tr>
  );
  return (
    <>
      <PageHeader
        title={t("reports.foodCostTitle")}
        description={t("reports.foodCostHint")}
        actions={
          <a
            href={`/o/${orgSlug}/reports/food-cost/export?from=${period.from}&to=${period.to}`}
            className={buttonClass("secondary")}
          >
            {t("reports.downloadCsv")}
          </a>
        }
      />
      <div className="space-y-6">
        <PeriodForm from={period.from} to={period.to} />
        <Alert tone="info">{t("reports.foodCostNote")}</Alert>
        {r.branches.length === 0 ? (
          <EmptyState title={t("reports.noSales")} />
        ) : (
          <Table label={t("reports.branchComparison")}>
            <thead>
              <tr>
                <Th>{t("reports.branch")}</Th>
                <Th>{t("reports.imports")}</Th>
                <Th>{t("reports.netSales")}</Th>
                <Th>{t("reports.costOfSales")}</Th>
                <Th>{t("reports.foodCost")}</Th>
                <Th>{t("reports.waste")}</Th>
                <Th>{t("reports.differences")}</Th>
                <Th>{t("reports.costWithLosses")}</Th>
              </tr>
            </thead>
            <tbody>
              {r.branches.map((b) =>
                row(`${b.branch.code} — ${b.branch.name}`, b, `branch-${b.branch.code}`),
              )}
              {row(<strong>{t("payables.total")}</strong>, r.total, "branch-total")}
            </tbody>
          </Table>
        )}
        {r.straddling.length > 0 ? (
          <Card title={t("reports.straddlingTitle")}>
            <p className="text-muted mb-2 text-sm">{t("reports.straddlingHint")}</p>
            <ul className="space-y-1 text-sm">
              {r.straddling.map((i) => (
                <li key={i.id}>
                  <Link
                    href={`/o/${orgSlug}/sales/${i.id}`}
                    className="ltr-value text-primary font-mono hover:underline"
                  >
                    {i.number}
                  </Link>{" "}
                  · {i.warehouse.code} ·{" "}
                  <span className="ltr-value">
                    {i.firstSale} → {i.lastSale}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <Card title={t("reports.trendTitle")}>
          <p className="text-muted mb-3 text-sm">{t("reports.trendHint")}</p>
          {trend.rows.length === 0 ? (
            <EmptyState title={t("reports.noSales")} />
          ) : (
            <Table label={t("reports.trendTitle")}>
              <thead>
                <tr>
                  <Th>{t("reports.branch")}</Th>
                  {trend.months.map((m) => (
                    <Th key={m}>
                      <span className="ltr-value text-xs">{m}</span>
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trend.rows.map((row) => (
                  <tr key={row.branch.id} data-testid={`trend-${row.branch.code}`}>
                    <Td>{row.branch.code}</Td>
                    {row.cells.map((c) => (
                      <Td key={c.month} className="text-xs tabular-nums">
                        {pct(c.foodCost)}
                      </Td>
                    ))}
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
