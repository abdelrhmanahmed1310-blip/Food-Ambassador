import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { InvoiceStatusBadge, MatchBadge } from "@/components/invoices/badges";
import { EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { hasPermission } from "@/modules/access/authorize";
import { listInvoices } from "@/modules/invoices/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";

const STATUSES = ["DRAFT", "POSTED", "CANCELLED"] as const;

export default async function InvoicesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/invoices">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "invoices.view")) notFound();
  const status = STATUSES.find((s) => s === sp.status);
  const [t, locale, money, invoices] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
    listInvoices(ctx, { status }),
  ]);
  const base = `/o/${orgSlug}/purchasing/invoices`;
  return (
    <>
      <PageHeader
        title={t("invoices.title")}
        description={t("invoices.hint")}
        actions={
          hasPermission(ctx.grants, "invoices.manage") ? (
            <Link href={`${base}/new`} className={buttonClass("primary")}>
              {t("invoices.new")}
            </Link>
          ) : null
        }
      />
      <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label={t("common.status")}>
        {[undefined, ...STATUSES].map((s) => (
          <Link
            key={s ?? "all"}
            href={s ? `${base}?status=${s}` : base}
            aria-current={s === status ? "page" : undefined}
            className="border-border hover:bg-surface-muted aria-[current=page]:bg-surface-muted rounded-md border px-3 py-1"
          >
            {s ? t(`invoices.statuses.${s}`) : t("invoices.all")}
          </Link>
        ))}
      </nav>
      {invoices.length === 0 ? (
        <EmptyState title={t("invoices.none")} />
      ) : (
        <Table label={t("invoices.title")}>
          <thead>
            <tr>
              <Th>{t("purchasing.number")}</Th>
              <Th>{t("invoices.supplierInvoiceNo")}</Th>
              <Th>{t("purchasing.supplier")}</Th>
              <Th>{t("invoices.invoiceDate")}</Th>
              <Th>{t("invoices.dueDate")}</Th>
              <Th>{t("tax.gross")}</Th>
              <Th>{t("invoices.match")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <Td>
                  <Link
                    href={`${base}/${inv.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {inv.number}
                  </Link>
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{inv.supplierInvoiceNo}</span>
                </Td>
                <Td>{(locale === "ar" && inv.supplier.nameAr) || inv.supplier.name}</Td>
                <Td className="whitespace-nowrap">
                  <span className="ltr-value">{inv.invoiceDate.toISOString().slice(0, 10)}</span>
                </Td>
                <Td className="whitespace-nowrap">
                  <span className="ltr-value">
                    {inv.dueDate?.toISOString().slice(0, 10) ?? "—"}
                  </span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value whitespace-nowrap">
                    {money.money(inv.grossAmount)}
                  </span>
                </Td>
                <Td>
                  {inv.status === "CANCELLED" ? "—" : <MatchBadge status={inv.matchStatus} />}
                </Td>
                <Td>
                  <InvoiceStatusBadge status={inv.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
