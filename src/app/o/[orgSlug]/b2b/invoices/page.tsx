import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listSalesInvoices } from "@/modules/b2b/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";

export default async function SalesInvoicesPage({
  params,
}: PageProps<"/o/[orgSlug]/b2b/invoices">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "b2b.view")) notFound();
  const [t, locale, money, invoices] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
    listSalesInvoices(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("b2b.invoices")} description={t("b2b.invoicesHint")} />
      {invoices.length === 0 ? (
        <EmptyState title={t("b2b.noInvoices")} />
      ) : (
        <Table label={t("b2b.invoices")}>
          <thead>
            <tr>
              <Th>{t("purchasing.number")}</Th>
              <Th>{t("b2b.customer")}</Th>
              <Th>{t("invoices.invoiceDate")}</Th>
              <Th>{t("tax.gross")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id}>
                <Td>
                  <Link
                    href={`/o/${orgSlug}/b2b/invoices/${i.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {i.number}
                  </Link>
                </Td>
                <Td>
                  <bdi>{(locale === "ar" && i.customer.nameAr) || i.customer.name}</bdi>
                </Td>
                <Td>
                  <span className="ltr-value">{i.invoiceDate.toISOString().slice(0, 10)}</span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">{money.money(i.grossAmount)}</span>
                </Td>
                <Td>
                  <Badge tone={i.status === "POSTED" ? "success" : "muted"}>
                    {t(`b2b.invoiceStatuses.${i.status}`)}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
