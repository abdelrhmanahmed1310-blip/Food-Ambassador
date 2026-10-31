import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { TextReasonForm } from "@/components/invoices/forms";
import { Alert, Badge, Card } from "@/components/ui/primitives";
import { PrintButton } from "@/components/ui/print-button";
import { isUuid } from "@/lib/uuid";
import { getSalesInvoice } from "@/modules/b2b/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, quantityFormatter } from "@/server/inventory-view";
import { cancelSalesInvoiceAction } from "../../actions";

/** Printable sales invoice. Not an e-invoice (ZATCA / ETA formats are POS4). */
export default async function SalesInvoicePage({
  params,
}: PageProps<"/o/[orgSlug]/b2b/invoices/[invoiceId]">) {
  const { orgSlug, invoiceId } = await params;
  if (!isUuid(invoiceId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const inv = await notFoundOnAppError(getSalesInvoice(ctx, invoiceId));
  const [t, locale, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const amount = (v: { toString(): string }) => (
    <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>
  );
  const pct = (r: { toString(): string } | null) =>
    r === null
      ? "—"
      : `${(Number(r.toString()) * 100).toLocaleString("en", { maximumFractionDigits: 4 })} %`;
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href={`/o/${orgSlug}/b2b/orders/${inv.delivery.order.id}`}
          className="text-primary text-sm hover:underline"
        >
          {inv.delivery.order.number}
        </Link>
        <div className="flex items-center gap-3">
          <Badge tone={inv.status === "POSTED" ? "success" : "muted"}>
            {t(`b2b.invoiceStatuses.${inv.status}`)}
          </Badge>
          {inv.status === "POSTED" ? <PrintButton label={t("recipes.print")} /> : null}
        </div>
      </div>
      {inv.cancelReason ? (
        <Alert tone="info">{t("invoices.cancelledBecause", { reason: inv.cancelReason })}</Alert>
      ) : null}
      <header className="border-border border-b pb-4">
        <h1 className="text-2xl font-semibold">
          {t(inv.taxAmount.isZero() ? "b2b.invoiceTitle" : "b2b.taxInvoiceTitle")}
        </h1>
        <p className="ltr-value font-mono text-sm">
          {inv.number} · {inv.invoiceDate.toISOString().slice(0, 10)}
        </p>
        <p className="mt-2 text-sm">
          <strong>{t("b2b.billTo")}:</strong>{" "}
          <bdi>{(locale === "ar" && inv.customer.nameAr) || inv.customer.name}</bdi>
          {inv.customer.taxId ? (
            <>
              {" "}
              · {t("b2b.vatNumber")}:{" "}
              <span className="ltr-value font-mono">{inv.customer.taxId}</span>
            </>
          ) : null}
        </p>
        <p className="text-muted text-xs">
          {t("b2b.delivery")}: <span className="ltr-value font-mono">{inv.delivery.number}</span>
          {inv.delivery.order.customerRef ? (
            <>
              {" "}
              · {t("b2b.customerRef")}:{" "}
              <span className="ltr-value">{inv.delivery.order.customerRef}</span>
            </>
          ) : null}
          {inv.dueDate ? (
            <>
              {" "}
              · {t("invoices.dueDate")}:{" "}
              <span className="ltr-value">{inv.dueDate.toISOString().slice(0, 10)}</span>
            </>
          ) : null}
        </p>
      </header>
      <table className="w-full text-sm" data-testid="sales-invoice-lines">
        <thead>
          <tr className="border-border border-b">
            <th className="py-1 text-start">{t("invoices.description")}</th>
            <th className="py-1 text-end">{t("common.quantity")}</th>
            <th className="py-1 text-end">{t("b2b.netPrice")}</th>
            <th className="py-1 text-end">{t("tax.rate")}</th>
            <th className="py-1 text-end">{t("tax.net")}</th>
            <th className="py-1 text-end">{t("tax.vat")}</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l) => (
            <tr key={l.id} className="border-border border-b">
              <td className="py-1">
                <bdi>{l.description}</bdi>
              </td>
              <td className="ltr-value py-1 text-end tabular-nums">{fmt(l.quantity)}</td>
              <td className="py-1 text-end tabular-nums">{amount(l.unitPrice)}</td>
              <td className="ltr-value py-1 text-end">{pct(l.taxRate)}</td>
              <td className="py-1 text-end tabular-nums">{amount(l.netAmount)}</td>
              <td className="py-1 text-end tabular-nums">{amount(l.taxAmount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={5} className="py-1 text-end">
              {t("tax.net")}
            </td>
            <td className="py-1 text-end tabular-nums">{amount(inv.netAmount)}</td>
          </tr>
          <tr>
            <td colSpan={5} className="py-1 text-end">
              {t("tax.vat")}
            </td>
            <td className="py-1 text-end tabular-nums">{amount(inv.taxAmount)}</td>
          </tr>
          <tr className="font-semibold">
            <td colSpan={5} className="py-1 text-end">
              {t("tax.gross")}
            </td>
            <td className="py-1 text-end tabular-nums" data-testid="sales-invoice-gross">
              {amount(inv.grossAmount)}
            </td>
          </tr>
        </tfoot>
      </table>
      <p className="text-muted text-xs print:hidden">{t("b2b.notEInvoice")}</p>
      <Card title={t("b2b.internal")}>
        <p className="text-sm print:hidden">
          {t("b2b.received")}: {amount(inv.received)} · {t("payables.open")}: {amount(inv.open)} ·{" "}
          {t("b2b.costOfGoods")}: {amount(inv.cost)} · {t("b2b.margin")}:{" "}
          <span data-testid="margin">{amount(inv.margin)}</span>
        </p>
      </Card>
      {inv.can.cancel ? (
        <Card title={t("invoices.cancel")}>
          <TextReasonForm
            action={cancelSalesInvoiceAction.bind(null, orgSlug, inv.id)}
            name="reason"
            label={t("invoices.cancelReason")}
            submitLabel={t("invoices.cancel")}
            variant="danger"
          />
        </Card>
      ) : null}
    </article>
  );
}
