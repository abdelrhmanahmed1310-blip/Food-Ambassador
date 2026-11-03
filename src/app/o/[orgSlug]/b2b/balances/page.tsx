import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import type { Decimal } from "@/lib/decimal";
import { hasPermission } from "@/modules/access/authorize";
import { customerBalances } from "@/modules/b2b/receivables";
import { AGING_BUCKETS } from "@/modules/invoices/payables-rules";
import { buttonClass } from "@/components/ui/styles";
import { isCalendarDate } from "@/lib/dates";
import { businessDate } from "@/modules/inventory/rules";
import { listCompanies } from "@/modules/organizations/companies";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyIn } from "@/server/fx-view";

export default async function CustomerBalancesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/b2b/balances">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "b2b.view")) notFound();
  const [t, locale, b, companies] = await Promise.all([
    getTranslations(),
    getLocale(),
    customerBalances(ctx, typeof sp.asOf === "string" ? sp.asOf : undefined),
    listCompanies(ctx),
  ]);
  // The accounting export is one company's books (ADR-086).
  const companyId =
    typeof sp.companyId === "string" && companies.some((c) => c.id === sp.companyId)
      ? sp.companyId
      : (companies.find((c) => c.isDefault)?.id ?? "");
  // Rows in their own currency, the equivalent and the total in base (ADR-054).
  // Each row's base amount is in its company's currency; the total in the group's (ADR-086).
  const moneyOf = await moneyIn([
    b.currency,
    ...b.rows.flatMap((r) => [r.currency, r.baseCurrency]),
  ]);
  const amount = (v: Decimal, currency = b.currency) => (
    <span className="ltr-value whitespace-nowrap">
      {v.isZero() ? "—" : moneyOf(currency).money(v)}
    </span>
  );
  const today = businessDate(ctx.timeZone);
  const from =
    typeof sp.from === "string" && isCalendarDate(sp.from) ? sp.from : `${today.slice(0, 7)}-01`;
  const to = typeof sp.to === "string" && isCalendarDate(sp.to) && sp.to >= from ? sp.to : today;
  const exportBase = `/o/${orgSlug}/b2b/balances/export`;
  return (
    <>
      <PageHeader title={t("b2b.balances")} description={t("b2b.balancesHint")} />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block font-medium">{t("payables.asOf")}</span>
          <input
            type="date"
            name="asOf"
            defaultValue={b.asOf}
            className="border-border bg-surface rounded-md border px-3 py-2"
          />
        </label>
        <button
          type="submit"
          className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
        >
          {t("common.apply")}
        </button>
      </form>
      {b.rows.length === 0 ? (
        <EmptyState title={t("b2b.noInvoices")} />
      ) : (
        <Table label={t("b2b.balances")}>
          <thead>
            <tr>
              <Th>{t("b2b.customer")}</Th>
              <Th>{t("fx.currency")}</Th>
              <Th>{t("payables.balance")}</Th>
              {AGING_BUCKETS.map((x) => (
                <Th key={x}>{t(`payables.aging.${x}`)}</Th>
              ))}
              <Th>{t("payables.unapplied")}</Th>
              <Th>{t("fx.inCompanyCurrency")}</Th>
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r) => (
              <tr
                key={`${r.customer.id}-${r.company.id}-${r.currency}`}
                data-testid={`customer-balance-${r.customer.code}${r.currency === r.baseCurrency ? "" : `-${r.currency}`}`}
              >
                <Td>
                  <Link
                    href={`/o/${orgSlug}/b2b/customers/${r.customer.id}`}
                    className="text-primary hover:underline"
                  >
                    <span className="ltr-value font-mono text-xs">{r.customer.code}</span>{" "}
                    <bdi>{(locale === "ar" && r.customer.nameAr) || r.customer.name}</bdi>
                  </Link>
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{r.currency}</span>
                </Td>
                <Td className="font-medium tabular-nums">{amount(r.balance, r.currency)}</Td>
                {AGING_BUCKETS.map((x) => (
                  <Td key={x} className="tabular-nums">
                    {amount(r.aging[x], r.currency)}
                  </Td>
                ))}
                <Td className="tabular-nums">{amount(r.unapplied, r.currency)}</Td>
                <Td className="tabular-nums">{amount(r.balanceBase, r.baseCurrency)}</Td>
              </tr>
            ))}
            <tr className="font-medium" data-testid="customer-balance-total">
              <Td>{t("payables.total")}</Td>
              <Td>
                <span className="ltr-value font-mono text-xs">{b.currency}</span>
              </Td>
              <Td />
              {AGING_BUCKETS.map((x) => (
                <Td key={x} />
              ))}
              <Td />
              <Td className="tabular-nums">{amount(b.totalBase)}</Td>
            </tr>
          </tbody>
        </Table>
      )}
      <div className="mt-6">
        <Card title={t("b2b.exportTitle")}>
          <p className="text-muted mb-3 text-sm">{t("b2b.exportHint")}</p>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="asOf" value={b.asOf} />
            {companies.length > 1 ? (
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t("companies.company")}</span>
                <select
                  name="companyId"
                  defaultValue={companyId}
                  className="border-border bg-surface rounded-md border px-3 py-2"
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {(
              [
                ["from", t("tax.from"), from],
                ["to", t("tax.to"), to],
              ] as const
            ).map(([name, label, value]) => (
              <label key={name} className="text-sm">
                <span className="mb-1 block font-medium">{label}</span>
                <input
                  type="date"
                  name={name}
                  defaultValue={value}
                  className="border-border bg-surface rounded-md border px-3 py-2"
                />
              </label>
            ))}
            <button
              type="submit"
              className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
            >
              {t("common.apply")}
            </button>
          </form>
          <div className="flex flex-wrap gap-3">
            {(["documents", "journal"] as const).flatMap((kind) =>
              (["csv", "xlsx"] as const).map((format) => (
                <a
                  key={`${kind}-${format}`}
                  href={`${exportBase}/${kind}?from=${from}&to=${to}&companyId=${companyId}${format === "xlsx" ? "&format=xlsx" : ""}`}
                  className={buttonClass("secondary")}
                >
                  {t(kind === "documents" ? "payables.exportDocuments" : "payables.exportJournal")}
                  {format === "xlsx" ? ` — ${t("common.excel")}` : ""}
                </a>
              )),
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
