import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CompanySelect } from "@/components/reports/company-select";
import { PeriodForm } from "@/components/reports/period-form";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { branchPnl, canSeePnl, type PnlColumn } from "@/modules/finance/pnl";
import type { PnlRow } from "@/modules/finance/pnl-rules";
import { listCompanies } from "@/modules/organizations/companies";
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

/** Branch profit and loss from sales, stock and expenses (ADR-111). */
export default async function BranchPnlPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/finance/pnl">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeePnl(ctx)) notFound();
  const period = reportPeriod(sp, ctx.timeZone);
  const company = typeof sp.company === "string" && isUuid(sp.company) ? sp.company : "";
  const branch = typeof sp.branch === "string" && isUuid(sp.branch) ? sp.branch : "";
  const [t, r, companies] = await Promise.all([
    getTranslations(),
    branchPnl(ctx, period, { companyId: company || undefined, branchId: branch || undefined }),
    listCompanies(ctx),
  ]);
  const fmt = new Map<string, Awaited<ReturnType<typeof moneyFormatter>>>();
  for (const c of new Set(r.columns.map((x) => x.currency))) fmt.set(c, await moneyFormatter(c));
  const money = (v: Decimal, c: string) => (
    <span className="ltr-value whitespace-nowrap">{fmt.get(c)!.money(v)}</span>
  );
  const heading = (c: PnlColumn) => {
    if (c.kind === "MONTH")
      return t(`salesReport.months.${c.label.slice(5, 7)}`) + ` ${c.label.slice(0, 4)}`;
    if (c.kind === "TOTAL") return t("pnl.total");
    if (c.kind === "LAST_YEAR") {
      const [from, to] = c.label.split("|");
      return t("pnl.lastYear", { from, to });
    }
    if (c.kind === "COMPANY") return t("pnl.companyTotal", { company: c.label });
    return c.label;
  };
  const query = `from=${period.from}&to=${period.to}${company ? `&company=${company}` : ""}${branch ? `&branch=${branch}` : ""}`;
  return (
    <>
      <PageHeader
        title={t("pnl.title")}
        description={t("pnl.hint")}
        actions={
          <a
            href={`/o/${orgSlug}/finance/pnl/export?${query}`}
            className={buttonClass("secondary")}
          >
            {t("reports.downloadCsv")}
          </a>
        }
      />
      <div className="space-y-6">
        <PeriodForm from={period.from} to={period.to}>
          <CompanySelect companies={companies} value={company} />
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("pnl.branch")}</span>
            <select name="branch" defaultValue={branch} className={`${inputClass} w-auto`}>
              <option value="">{t("pnl.allBranches")}</option>
              {r.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </label>
        </PeriodForm>
        {r.columns.length === 0 ? (
          <EmptyState title={t("pnl.empty")} />
        ) : (
          <Card title={t("pnl.statement", { from: period.from, to: period.to })}>
            <Table label={t("pnl.title")}>
              <thead>
                <tr>
                  <Th>{t("pnl.line")}</Th>
                  {r.columns.map((c) => (
                    <Th key={c.key}>
                      {heading(c)} <span className="text-muted font-normal">({c.currency})</span>
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.rows.map((row) => (
                  <tr
                    key={row}
                    data-testid={`pnl-row-${row}`}
                    className={SUBTOTALS.includes(row) ? "font-semibold" : undefined}
                  >
                    <Td>
                      <span
                        className={SOURCES.includes(row) ? "text-muted ps-4 text-sm" : undefined}
                      >
                        {t(`pnl.rows.${row}`)}
                      </span>
                    </Td>
                    {r.columns.map((c) => (
                      <Td key={c.key}>
                        {money(c.values[row], c.currency)}
                        {c.shares[row] === null || row === "SALES" ? null : (
                          <span className="ltr-value text-muted block text-xs">
                            {c.shares[row]!.times(100).toFixed(1)}%
                          </span>
                        )}
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="text-muted mt-3 text-xs">{t("pnl.note")}</p>
          </Card>
        )}
      </div>
    </>
  );
}
