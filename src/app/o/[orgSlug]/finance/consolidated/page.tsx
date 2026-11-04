import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PeriodForm } from "@/components/reports/period-form";
import { Alert, Card, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import type { Decimal } from "@/lib/decimal";
import { canSeeConsolidation, consolidatedPnl } from "@/modules/finance/consolidation";
import type { PnlRow } from "@/modules/finance/pnl-rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { reportPeriod } from "@/server/report-period";

const SUBTOTALS: readonly PnlRow[] = [
  "SALES",
  "GROSS_PROFIT",
  "TOTAL_EXPENSES",
  "OPERATING_RESULT",
];
const SOURCES: readonly PnlRow[] = ["SALES_POS", "SALES_IMPORTED", "SALES_B2B"];

/** The group's P&L across companies in the group currency (ADR-112). */
export default async function ConsolidatedPnlPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/finance/consolidated">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeConsolidation(ctx)) notFound();
  const period = reportPeriod(sp, ctx.timeZone);
  const [t, r] = await Promise.all([getTranslations(), consolidatedPnl(ctx, period)]);
  const fmts = new Map<string, Awaited<ReturnType<typeof moneyFormatter>>>();
  for (const c of new Set([r.currency, ...r.companies.map((x) => x.company.currency)]))
    fmts.set(c, await moneyFormatter(c));
  const money = (v: Decimal, c = r.currency) => (
    <span className="ltr-value whitespace-nowrap">{fmts.get(c)!.money(v)}</span>
  );
  const shown = r.companies.filter((c) => c.converted !== null);
  const left = r.companies.filter((c) => c.converted === null);
  return (
    <>
      <PageHeader
        title={t("consolidated.title")}
        description={t("consolidated.hint", { currency: r.currency })}
        actions={
          <a
            href={`/o/${orgSlug}/finance/consolidated/export?from=${period.from}&to=${period.to}`}
            className={buttonClass("secondary")}
          >
            {t("reports.downloadCsv")}
          </a>
        }
      />
      <div className="space-y-6">
        <PeriodForm from={period.from} to={period.to} />
        {left.length > 0 ? (
          <Alert tone="error">
            {t("consolidated.missingRates", {
              currencies: r.missingRates.join(", "),
              companies: left.map((c) => c.company.code).join(", "),
            })}
          </Alert>
        ) : null}
        <Card
          title={t("consolidated.statement", {
            from: period.from,
            to: period.to,
            currency: r.currency,
          })}
        >
          <Table label={t("consolidated.title")}>
            <thead>
              <tr>
                <Th>{t("pnl.line")}</Th>
                {shown.map((c) => (
                  <Th key={c.company.id}>
                    {c.company.code} — {c.company.name}
                  </Th>
                ))}
                <Th>{t("consolidated.eliminations")}</Th>
                <Th>{t("consolidated.group")}</Th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((row) => (
                <tr
                  key={row}
                  data-testid={`group-row-${row}`}
                  className={SUBTOTALS.includes(row) ? "font-semibold" : undefined}
                >
                  <Td>
                    <span className={SOURCES.includes(row) ? "text-muted ps-4 text-sm" : undefined}>
                      {t(`pnl.rows.${row}`)}
                    </span>
                  </Td>
                  {shown.map((c) => (
                    <Td key={c.company.id}>{money(c.converted!.values[row])}</Td>
                  ))}
                  <Td>
                    {r.eliminations.values[row].isZero() ? (
                      <span className="text-muted">—</span>
                    ) : (
                      money(r.eliminations.values[row])
                    )}
                  </Td>
                  <Td>
                    {money(r.group.values[row])}
                    {r.group.shares[row] === null || row === "SALES" ? null : (
                      <span className="ltr-value text-muted block text-xs">
                        {r.group.shares[row]!.times(100).toFixed(1)}%
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="text-muted mt-3 text-xs">{t("consolidated.note")}</p>
        </Card>
        <Card title={t("consolidated.localTitle")}>
          <Table label={t("consolidated.localTitle")}>
            <thead>
              <tr>
                <Th>{t("consolidated.company")}</Th>
                <Th>{t("pnl.rows.SALES")}</Th>
                <Th>{t("consolidated.intercompany")}</Th>
                <Th>{t("pnl.rows.OPERATING_RESULT")}</Th>
                <Th>{t("consolidated.inGroup", { currency: r.currency })}</Th>
              </tr>
            </thead>
            <tbody>
              {r.companies.map((c) => (
                <tr key={c.company.id}>
                  <Td>
                    {c.company.code} — {c.company.name}
                  </Td>
                  <Td>{money(c.local.values.SALES, c.company.currency)}</Td>
                  <Td>{money(c.intercompanySales, c.company.currency)}</Td>
                  <Td>{money(c.local.values.OPERATING_RESULT, c.company.currency)}</Td>
                  <Td>
                    {c.converted ? (
                      money(c.converted.values.OPERATING_RESULT)
                    ) : (
                      <span className="text-muted">{t("consolidated.noRate")}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
