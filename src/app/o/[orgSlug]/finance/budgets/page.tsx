import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import {
  budgetBranches,
  budgetGrid,
  budgetVsActual,
  canSeeBudgets,
} from "@/modules/finance/budgets";
import { DERIVED_ROWS, variance, type BudgetRow } from "@/modules/finance/budget-rules";
import { businessDate } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { setBudgetLineAction } from "./actions";
import { BudgetLineForm } from "./budget-line-form";

/** A branch's monthly budget and how it compares with actual results (ADR-110). */
export default async function BudgetsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/finance/budgets">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeBudgets(ctx)) notFound();
  const [t, branches] = await Promise.all([getTranslations(), budgetBranches(ctx)]);
  const base = `/o/${orgSlug}/finance/budgets`;
  if (branches.length === 0)
    return (
      <>
        <PageHeader title={t("budgets.title")} description={t("budgets.hint")} />
        <EmptyState title={t("budgets.noBranches")} />
      </>
    );
  const branchId =
    typeof sp.branch === "string" && isUuid(sp.branch) && branches.some((b) => b.id === sp.branch)
      ? sp.branch
      : branches[0].id;
  const today = businessDate(ctx.timeZone);
  const year =
    typeof sp.year === "string" && /^\d{4}$/.test(sp.year)
      ? Number(sp.year)
      : Number(today.slice(0, 4));
  const [grid, r] = await Promise.all([
    budgetGrid(ctx, branchId, year),
    budgetVsActual(ctx, branchId, year),
  ]);
  const defaultMonth = r.lastMonth === 0 ? "01" : String(r.lastMonth).padStart(2, "0");
  const month =
    typeof sp.month === "string" && /^(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month : defaultMonth;
  const m = r.months.find((x) => x.month === month)!;
  const fmt = await moneyFormatter(r.currency);
  const money = (v: Decimal | null) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value whitespace-nowrap">{fmt.money(v)}</span>
    );
  const varianceCell = (v: ReturnType<typeof variance>) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="flex flex-wrap items-center gap-2">
        {money(v.difference)}
        {v.share === null ? null : (
          <span className="ltr-value text-muted text-xs">{v.share.times(100).toFixed(1)}%</span>
        )}
        <Badge tone={v.favourable ? "success" : "danger"}>
          {t(v.favourable ? "budgets.favourable" : "budgets.unfavourable")}
        </Badge>
      </span>
    );
  const query = (o: Record<string, string | number>) =>
    `${base}?${new URLSearchParams({ branch: branchId, year: String(year), month, ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) })}`;
  const derived = (row: BudgetRow) => DERIVED_ROWS.includes(row);
  const lines = [
    "COST_OF_SALES",
    "OCCUPANCY",
    "UTILITIES",
    "STAFF",
    "MARKETING",
    "REPAIRS",
    "ADMINISTRATION",
    "DELIVERY",
    "OTHER",
  ] as const;
  return (
    <>
      <PageHeader
        title={t("budgets.title")}
        description={t("budgets.hint")}
        actions={
          <Link
            href={`/o/${orgSlug}/reports/sales/targets?year=${year}`}
            className={buttonClass("secondary")}
          >
            {t("budgets.salesTargets")}
          </Link>
        }
      />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("budgets.branch")}</span>
            <select name="branch" defaultValue={branchId} className={`${inputClass} w-auto`}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("budgets.month")}</span>
            <select name="month" defaultValue={month} className={`${inputClass} w-auto`}>
              {r.months.map((x) => (
                <option key={x.month} value={x.month}>
                  {t(`salesReport.months.${x.month}`)}
                </option>
              ))}
            </select>
          </label>
          <input type="hidden" name="year" value={year} />
          <button type="submit" className={buttonClass("secondary")}>
            {t("budgets.show")}
          </button>
          <nav className="flex gap-4 self-center text-sm" aria-label={t("budgets.year")}>
            <Link href={query({ year: year - 1 })} className="text-primary hover:underline">
              {year - 1}
            </Link>
            <span className="font-medium" aria-current="page">
              {year}
            </span>
            <Link href={query({ year: year + 1 })} className="text-primary hover:underline">
              {year + 1}
            </Link>
          </nav>
        </form>

        <Card
          title={t("budgets.comparison", {
            branch: `${r.branch.code} — ${r.branch.name}`,
            currency: r.currency,
          })}
        >
          <p className="text-muted mb-3 text-sm">
            {r.lastMonth === 0
              ? t("budgets.notStarted")
              : t("budgets.ytdThrough", {
                  month: t(`salesReport.months.${String(r.lastMonth).padStart(2, "0")}`),
                  year,
                })}
          </p>
          <Table label={t("budgets.comparisonLabel")}>
            <thead>
              <tr>
                <Th>{t("budgets.line")}</Th>
                <Th>{t("budgets.monthBudget", { month: t(`salesReport.months.${month}`) })}</Th>
                <Th>{t("budgets.monthActual", { month: t(`salesReport.months.${month}`) })}</Th>
                <Th>{t("budgets.variance")}</Th>
                <Th>{t("budgets.ytdBudget")}</Th>
                <Th>{t("budgets.ytdActual")}</Th>
                <Th>{t("budgets.variance")}</Th>
                <Th>{t("budgets.yearBudget")}</Th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((row) => (
                <tr
                  key={row.row}
                  data-testid={`budget-row-${row.row}`}
                  className={derived(row.row) ? "font-semibold" : undefined}
                >
                  <Td>{t(`budgets.rows.${row.row}`)}</Td>
                  <Td>{money(m.budget[row.row])}</Td>
                  <Td>
                    {m.closed ? money(m.actual[row.row]) : <span className="text-muted">—</span>}
                  </Td>
                  <Td>
                    {m.closed ? (
                      varianceCell(variance(row.row, m.budget[row.row], m.actual[row.row] ?? 0))
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td>{money(row.ytdBudget)}</Td>
                  <Td>{money(row.ytdActual)}</Td>
                  <Td>{varianceCell(row.ytdVariance)}</Td>
                  <Td>{money(row.yearBudget)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="text-muted mt-3 text-xs">{t("budgets.actualsNote")}</p>
        </Card>

        {grid.canManage ? (
          <Card title={t("budgets.setTitle", { year })}>
            <p className="text-muted mb-4 text-sm">{t("budgets.setHint")}</p>
            <div className="space-y-3">
              {lines.map((line) => (
                <details
                  key={line}
                  className="border-border rounded-lg border p-3"
                  data-testid={`budget-line-${line}`}
                >
                  <summary className="cursor-pointer font-medium">
                    {t(`budgets.rows.${line}`)}
                  </summary>
                  <div className="mt-3">
                    <BudgetLineForm
                      action={setBudgetLineAction.bind(null, orgSlug, branchId, year, line)}
                      currency={grid.currency}
                      values={Object.fromEntries(
                        grid.months.flatMap((x) =>
                          x.rows[line] === null ? [] : [[x.month, x.rows[line]!.toFixed(2)]],
                        ),
                      )}
                    />
                  </div>
                </details>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
