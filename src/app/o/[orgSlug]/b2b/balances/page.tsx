import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import type { Decimal } from "@/lib/decimal";
import { hasPermission } from "@/modules/access/authorize";
import { customerBalances } from "@/modules/b2b/receivables";
import { AGING_BUCKETS } from "@/modules/invoices/payables-rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";

export default async function CustomerBalancesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/b2b/balances">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "b2b.view")) notFound();
  const [t, locale, money, b] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
    customerBalances(ctx, typeof sp.asOf === "string" ? sp.asOf : undefined),
  ]);
  const amount = (v: Decimal) => (
    <span className="ltr-value whitespace-nowrap">{v.isZero() ? "—" : money.money(v)}</span>
  );
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
              <Th>{t("payables.balance")}</Th>
              {AGING_BUCKETS.map((x) => (
                <Th key={x}>{t(`payables.aging.${x}`)}</Th>
              ))}
              <Th>{t("payables.unapplied")}</Th>
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r) => (
              <tr key={r.customer.id} data-testid={`customer-balance-${r.customer.code}`}>
                <Td>
                  <Link
                    href={`/o/${orgSlug}/b2b/customers/${r.customer.id}`}
                    className="text-primary hover:underline"
                  >
                    <span className="ltr-value font-mono text-xs">{r.customer.code}</span>{" "}
                    <bdi>{(locale === "ar" && r.customer.nameAr) || r.customer.name}</bdi>
                  </Link>
                </Td>
                <Td className="font-medium tabular-nums">{amount(r.balance)}</Td>
                {AGING_BUCKETS.map((x) => (
                  <Td key={x} className="tabular-nums">
                    {amount(r.aging[x])}
                  </Td>
                ))}
                <Td className="tabular-nums">{amount(r.unapplied)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
