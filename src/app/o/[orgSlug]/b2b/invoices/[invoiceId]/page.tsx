import Link from "next/link";
import QRCode from "qrcode";
import { notFound } from "next/navigation";
import { currencyOf } from "@/modules/fx/service";
import { getLocale, getTranslations } from "next-intl/server";
import { TextReasonForm } from "@/components/invoices/forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Alert, Badge, Card } from "@/components/ui/primitives";
import { PrintButton } from "@/components/ui/print-button";
import { buttonClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { getSalesInvoice } from "@/modules/b2b/service";
import { salesInvoiceEInvoice } from "@/modules/zatca/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, quantityFormatter } from "@/server/inventory-view";
import { cancelSalesInvoiceAction, clearSalesInvoiceAction } from "../../actions";

const CLEARED = ["CLEARED", "CLEARED_WITH_WARNINGS"];
type ZatcaMessage = { code?: string; message?: string };

/**
 * Printable sales invoice. In Saudi Arabia, once the back office's unit is
 * onboarded, the legal invoice is ZATCA's cleared document: its QR is
 * printed, and an invoice not yet cleared says so (ADR-072).
 */
export default async function SalesInvoicePage({
  params,
}: PageProps<"/o/[orgSlug]/b2b/invoices/[invoiceId]">) {
  const { orgSlug, invoiceId } = await params;
  if (!isUuid(invoiceId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const inv = await notFoundOnAppError(getSalesInvoice(ctx, invoiceId));
  const einvoice = await salesInvoiceEInvoice(ctx, invoiceId);
  const doc = einvoice.find((d) => d.type === "INVOICE");
  const note = einvoice.find((d) => d.type === "CREDIT_NOTE");
  const cleared = doc ? CLEARED.includes(doc.status) : false;
  const qrSvg =
    doc && cleared
      ? await QRCode.toString(doc.qr, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      : null;
  const messages = (d: (typeof einvoice)[number]) => {
    const r = (d.response ?? {}) as {
      validationResults?: { errorMessages?: ZatcaMessage[]; warningMessages?: ZatcaMessage[] };
    };
    return [
      ...(r.validationResults?.errorMessages ?? []),
      ...(r.validationResults?.warningMessages ?? []),
    ]
      .map((m) => [m.code, m.message].filter(Boolean).join(": "))
      .slice(0, 5);
  };
  const [t, locale, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    moneyFormatter(inv.currency),
  ]);
  const amount = (v: { toString(): string }) => (
    <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>
  );
  // Cost and margin are in the invoice's company's currency (ADR-054/086).
  const bookCurrency = await currencyOf(ctx, { companyId: inv.companyId });
  const base = await moneyFormatter(bookCurrency);
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
          <a
            href={`/o/${orgSlug}/b2b/invoices/${inv.id}/pdf`}
            className={`${buttonClass("secondary")} print:hidden`}
            data-testid="invoice-pdf"
          >
            {t("documents.pdf")}
          </a>
        </div>
      </div>
      {doc ? (
        <section
          className="border-border space-y-2 rounded-md border p-3 text-sm print:border-0 print:p-0"
          data-testid="einvoice"
        >
          <p className="flex flex-wrap items-center gap-2 print:hidden">
            <strong>{t("zatca.eInvoice")}</strong>
            <Badge tone={cleared ? "success" : doc.status === "REJECTED" ? "danger" : "warning"}>
              {t(`zatca.statuses.${doc.status}`)}
            </Badge>
            {note ? (
              <span>
                {t("zatca.creditNote")} {note.number} · {t(`zatca.statuses.${note.status}`)}
              </span>
            ) : null}
          </p>
          {!cleared ? (
            <Alert tone={doc.status === "REJECTED" ? "error" : "info"}>
              {doc.status === "REJECTED" ? t("zatca.rejectedInvoice") : t("zatca.notClearedYet")}
            </Alert>
          ) : null}
          {[doc, note]
            .filter(Boolean)
            .flatMap((d) => messages(d!))
            .map((m, i) => (
              <p key={i} className="text-muted ltr-value text-xs print:hidden">
                {m}
              </p>
            ))}
          {[doc, note].some((d) => d?.status === "PENDING") &&
          hasPermission(ctx.grants, "b2b.manage") ? (
            <div className="print:hidden">
              <ConfirmActionButton
                action={clearSalesInvoiceAction.bind(null, orgSlug, inv.id)}
                label={t("zatca.clearNow")}
                variant="secondary"
              />
            </div>
          ) : null}
          {qrSvg ? (
            <div
              className="w-36"
              data-testid="zatca-qr"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : null}
        </section>
      ) : null}
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
        {inv.currency !== bookCurrency ? (
          <p className="ltr-value text-muted text-sm" data-testid="fx-rate">
            {inv.currency} · 1 {inv.currency} = {inv.exchangeRate.toFixed().replace(/\.?0+$/, "")}{" "}
            {bookCurrency}
            {inv.rateDate ? ` (${inv.rateDate.toISOString().slice(0, 10)})` : ""} ·{" "}
            {t("fx.totalInBase", { currency: bookCurrency })}: {base.money(inv.grossAmountBase)}
          </p>
        ) : null}
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
          {t("b2b.costOfGoods")}: {base.money(inv.cost)} · {t("b2b.margin")}:{" "}
          <span data-testid="margin">{base.money(inv.margin)}</span>
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
