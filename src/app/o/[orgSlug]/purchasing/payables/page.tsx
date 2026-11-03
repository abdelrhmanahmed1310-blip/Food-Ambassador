import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { isCalendarDate } from "@/lib/dates";
import type { Decimal } from "@/lib/decimal";
import { hasPermission } from "@/modules/access/authorize";
import { businessDate } from "@/modules/inventory/rules";
import { journalReady } from "@/modules/invoices/accounting";
import { supplierBalances } from "@/modules/invoices/payables";
import { AGING_BUCKETS } from "@/modules/invoices/payables-rules";
import { listCompanies } from "@/modules/organizations/companies";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";

export default async function PayablesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/payables">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "invoices.view")) notFound();
  const today = businessDate(ctx.timeZone);
  const asOf = typeof sp.asOf === "string" && isCalendarDate(sp.asOf) ? sp.asOf : today;
  const from =
    typeof sp.from === "string" && isCalendarDate(sp.from) ? sp.from : `${today.slice(0, 7)}-01`;
  const to = typeof sp.to === "string" && isCalendarDate(sp.to) && sp.to >= from ? sp.to : today;
  const [t, locale, balances, ready, companies] = await Promise.all([
    getTranslations(),
    getLocale(),
    supplierBalances(ctx, asOf),
    journalReady(ctx),
    listCompanies(ctx),
  ]);
  const companyId =
    typeof sp.companyId === "string" && companies.some((c) => c.id === sp.companyId)
      ? sp.companyId
      : (companies.find((c) => c.isDefault)?.id ?? "");
  // Totals are in the group currency; each row's base amount in its company's (ADR-086).
  const money = await moneyFormatter(balances.currency);
  const severalCompanies = companies.length > 1;
  const base = `/o/${orgSlug}/purchasing/payables`;
  // Rows are in their own currency (ADR-050); totals in base currency.
  const formatters = new Map(
    await Promise.all(
      [...new Set(balances.rows.flatMap((r) => [r.currency, r.baseCurrency]))].map(
        async (c) => [c, await moneyFormatter(c)] as const,
      ),
    ),
  );
  const amount = (v: Decimal, currency = balances.currency) => (
    <span className="ltr-value whitespace-nowrap">
      {v.isZero() ? "—" : (formatters.get(currency) ?? money).money(v)}
    </span>
  );
  const dateInput = (name: string, label: string, value: string) => (
    <label className="text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <input
        type="date"
        name={name}
        defaultValue={value}
        className="border-border bg-surface rounded-md border px-3 py-2"
      />
    </label>
  );
  const apply = (
    <button
      type="submit"
      className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
    >
      {t("common.apply")}
    </button>
  );
  return (
    <>
      <PageHeader title={t("payables.title")} description={t("payables.hint")} />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          {dateInput("asOf", t("payables.asOf"), asOf)}
          {apply}
        </form>
        {balances.missingRates.length > 0 ? (
          <Alert tone="error">
            {t("fx.missingRates", { currencies: balances.missingRates.join(", ") })}
          </Alert>
        ) : null}
        {balances.rows.length === 0 ? (
          <EmptyState title={t("payables.none")} />
        ) : (
          <Table label={t("payables.title")}>
            <thead>
              <tr>
                <Th>{t("purchasing.supplier")}</Th>
                {severalCompanies ? <Th>{t("companies.company")}</Th> : null}
                <Th>{t("fx.currency")}</Th>
                <Th>{t("payables.balance")}</Th>
                {AGING_BUCKETS.map((b) => (
                  <Th key={b}>{t(`payables.aging.${b}`)}</Th>
                ))}
                <Th>{t("payables.unapplied")}</Th>
                <Th>
                  {severalCompanies
                    ? t("fx.inCompanyCurrency")
                    : t("fx.inBase", { currency: balances.currency })}
                </Th>
              </tr>
            </thead>
            <tbody>
              {balances.rows.map((r) => (
                <tr
                  key={`${r.supplier.id}-${r.company.id}-${r.currency}`}
                  data-testid={`balance-${r.supplier.code}${r.currency === r.baseCurrency ? "" : `-${r.currency}`}`}
                >
                  <Td>
                    <Link
                      href={`${base}/${r.supplier.id}?currency=${r.currency}&companyId=${r.company.id}`}
                      className="text-primary hover:underline"
                    >
                      <span className="ltr-value font-mono text-xs">{r.supplier.code}</span>{" "}
                      <bdi>{(locale === "ar" && r.supplier.nameAr) || r.supplier.name}</bdi>
                    </Link>
                  </Td>
                  {severalCompanies ? (
                    <Td>
                      <span className="ltr-value font-mono text-xs">{r.company.code}</span>
                    </Td>
                  ) : null}
                  <Td>
                    <span className="ltr-value font-mono text-xs">{r.currency}</span>
                  </Td>
                  <Td className="font-medium tabular-nums">{amount(r.balance, r.currency)}</Td>
                  {AGING_BUCKETS.map((b) => (
                    <Td key={b} className="tabular-nums">
                      {amount(r.aging[b], r.currency)}
                    </Td>
                  ))}
                  <Td className="tabular-nums">{amount(r.unapplied, r.currency)}</Td>
                  <Td className="tabular-nums">{amount(r.balanceBase, r.baseCurrency)}</Td>
                </tr>
              ))}
              <tr className="font-medium" data-testid="balance-total">
                <Td>{t("payables.total")}</Td>
                {severalCompanies ? <Td /> : null}
                <Td>
                  <span className="ltr-value font-mono text-xs">{balances.currency}</span>
                </Td>
                <Td className="tabular-nums">{amount(balances.total.balanceBase)}</Td>
                {AGING_BUCKETS.map((b) => (
                  <Td key={b} className="tabular-nums">
                    {amount(balances.total.aging[b])}
                  </Td>
                ))}
                <Td className="tabular-nums">{amount(balances.total.unappliedBase)}</Td>
                <Td className="tabular-nums">{amount(balances.total.balanceBase)}</Td>
              </tr>
            </tbody>
          </Table>
        )}
        <p className="text-muted text-xs">{t("payables.agingNote")}</p>

        <Card title={t("payables.exportTitle")}>
          <p className="text-muted mb-3 text-sm">{t("payables.exportHint")}</p>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="asOf" value={asOf} />
            {dateInput("from", t("tax.from"), from)}
            {dateInput("to", t("tax.to"), to)}
            {severalCompanies ? (
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
            {apply}
          </form>
          <div className="flex flex-wrap gap-3">
            <a
              href={`${base}/export/documents?from=${from}&to=${to}&companyId=${companyId}`}
              className={buttonClass("secondary")}
            >
              {t("payables.exportDocuments")}
            </a>
            <a
              href={`${base}/export/documents?from=${from}&to=${to}&companyId=${companyId}&format=xlsx`}
              className={buttonClass("secondary")}
            >
              {t("payables.exportDocuments")} — {t("common.excel")}
            </a>
            <a href={`${base}/revaluation`} className={buttonClass("secondary")}>
              {t("revaluation.title")}
            </a>
            {ready ? (
              <a
                href={`${base}/export/journal?from=${from}&to=${to}&companyId=${companyId}`}
                className={buttonClass("secondary")}
              >
                {t("payables.exportJournal")}
              </a>
            ) : null}
            {ready ? (
              <a
                href={`${base}/export/journal?from=${from}&to=${to}&companyId=${companyId}&format=xlsx`}
                className={buttonClass("secondary")}
              >
                {t("payables.exportJournal")} — {t("common.excel")}
              </a>
            ) : null}
          </div>
          {!ready ? (
            <div className="mt-3">
              <Alert tone="info">{t("payables.journalNeedsAccounts")}</Alert>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
