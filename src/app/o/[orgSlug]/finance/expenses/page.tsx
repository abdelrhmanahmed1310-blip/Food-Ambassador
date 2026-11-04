import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { PeriodForm } from "@/components/reports/period-form";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { canSeeExpenses, expenseFormOptions, listExpenses } from "@/modules/finance/expenses";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { reportPeriod } from "@/server/report-period";

/** Operating expenses with totals per P&L group (ADR-109). */
export default async function ExpensesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/finance/expenses">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeExpenses(ctx)) notFound();
  const period = reportPeriod(sp, ctx.timeZone);
  const branch = typeof sp.branch === "string" && isUuid(sp.branch) ? sp.branch : "";
  const category = typeof sp.category === "string" && isUuid(sp.category) ? sp.category : "";
  const [t, locale, r, options] = await Promise.all([
    getTranslations(),
    getLocale(),
    listExpenses(ctx, {
      from: period.from,
      to: period.to,
      branchId: branch || undefined,
      categoryId: category || undefined,
    }),
    expenseFormOptions(ctx),
  ]);
  const fmt = new Map<string, Awaited<ReturnType<typeof moneyFormatter>>>();
  for (const c of new Set([...r.rows.map((x) => x.currency), ...r.totals.map((x) => x.currency)]))
    fmt.set(c, await moneyFormatter(c));
  const money = (v: { toString(): string }, c: string) => (
    <span className="ltr-value whitespace-nowrap">{fmt.get(c)!.money(v)}</span>
  );
  const name = (x: { name: string; nameAr?: string | null }) =>
    (locale === "ar" && x.nameAr) || x.name;
  const base = `/o/${orgSlug}/finance/expenses`;
  const query = `from=${period.from}&to=${period.to}${branch ? `&branch=${branch}` : ""}${category ? `&category=${category}` : ""}`;
  const canRecord = holdsAnyGrant(ctx.grants, "expenses.manage");
  return (
    <>
      <PageHeader
        title={t("expenses.title")}
        description={t("expenses.hint")}
        actions={
          <span className="flex flex-wrap gap-2">
            {canRecord ? (
              <Link href={`${base}/new`} className={buttonClass("primary")}>
                {t("expenses.new")}
              </Link>
            ) : null}
            <Link href={`${base}/setup`} className={buttonClass("secondary")}>
              {t("expenses.setup")}
            </Link>
            <a href={`${base}/export?${query}`} className={buttonClass("secondary")}>
              {t("reports.downloadCsv")}
            </a>
          </span>
        }
      />
      <div className="space-y-6">
        <PeriodForm from={period.from} to={period.to}>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("expenses.branch")}</span>
            <select name="branch" defaultValue={branch} className={`${inputClass} w-auto`}>
              <option value="">{t("expenses.allBranches")}</option>
              {options.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("expenses.category")}</span>
            <select name="category" defaultValue={category} className={`${inputClass} w-auto`}>
              <option value="">{t("expenses.allCategories")}</option>
              {options.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {name(c)}
                </option>
              ))}
            </select>
          </label>
        </PeriodForm>
        {r.totals.map((tot) => (
          <Card key={tot.currency} title={t("expenses.totals", { currency: tot.currency })}>
            <div
              className="grid grid-cols-2 gap-3 lg:grid-cols-4"
              data-testid={`expense-totals-${tot.currency}`}
            >
              <div className="border-border bg-surface rounded-xl border p-4 shadow-sm">
                <p className="text-muted text-xs font-medium">{t("expenses.totalNet")}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {money(tot.net, tot.currency)}
                </p>
              </div>
              {tot.groups.map((g) => (
                <div
                  key={g.group}
                  className="border-border bg-surface rounded-xl border p-4 shadow-sm"
                >
                  <p className="text-muted text-xs font-medium">
                    {t(`expenses.groups.${g.group}`)}
                  </p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {money(g.net, tot.currency)}
                  </p>
                </div>
              ))}
            </div>
          </Card>
        ))}
        {r.rows.length === 0 ? (
          <EmptyState title={t("expenses.empty")} />
        ) : (
          <Table label={t("expenses.title")}>
            <thead>
              <tr>
                <Th>{t("expenses.number")}</Th>
                <Th>{t("expenses.date")}</Th>
                <Th>{t("expenses.branch")}</Th>
                <Th>{t("expenses.category")}</Th>
                <Th>{t("expenses.description")}</Th>
                <Th>{t("expenses.net")}</Th>
                <Th>{t("expenses.tax")}</Th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((e) => (
                <tr key={e.id} className={e.status === "REVERSED" ? "opacity-60" : undefined}>
                  <Td>
                    <Link
                      href={`${base}/${e.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {e.number}
                    </Link>
                    {e.status === "REVERSED" ? (
                      <span className="block">
                        <Badge tone="muted">{t("expenses.reversed")}</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td className="ltr-value tabular-nums">
                    {e.expenseDate.toISOString().slice(0, 10)}
                  </Td>
                  <Td className="ltr-value font-mono text-xs">{e.branch.code}</Td>
                  <Td>
                    {name(e.category)}
                    <span className="text-muted block text-xs">
                      {t(`expenses.groups.${e.category.group}`)}
                    </span>
                  </Td>
                  <Td>
                    {e.description}
                    {e.supplier ? (
                      <span className="text-muted block text-xs">{e.supplier.name}</span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">{money(e.netAmount, e.currency)}</Td>
                  <Td className="tabular-nums">{money(e.taxAmount, e.currency)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
