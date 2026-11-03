import { getTranslations } from "next-intl/server";
import { salesInvoiceForPrint } from "@/modules/documents/service";
import { renderPdf, pdfResponse } from "@/server/pdf/document";
import { pdfFormat } from "@/server/pdf/format";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/**
 * The B2B sales invoice as a PDF for the customer (ADR-089). Where ZATCA
 * e-invoicing applies, the cleared XML stays the legal document; this is
 * its readable copy.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/b2b/invoices/[invoiceId]/pdf">,
) {
  const { orgSlug, invoiceId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    const { invoice: inv, seller } = await salesInvoiceForPrint(ctx, invoiceId);
    const [t, f] = await Promise.all([getTranslations("documents"), pdfFormat()]);
    const c = inv.customer;
    const pdf = await renderPdf({
      title: seller.vatNumber ? t("taxInvoice") : t("invoice"),
      number: inv.number,
      seller: {
        name: seller.legalName,
        lines: seller.address,
        facts: [
          ...(seller.vatNumber
            ? ([[t("vatNumber"), seller.vatNumber]] as Array<[string, string]>)
            : []),
          ...(seller.crNumber
            ? ([[t("crNumber"), seller.crNumber]] as Array<[string, string]>)
            : []),
        ],
      },
      party: {
        label: t("customer"),
        name: c.name,
        lines: [
          ...[
            [c.buildingNumber, c.street].filter(Boolean).join(" "),
            [c.district, c.city, c.postalCode].filter(Boolean).join(", "),
          ].filter((l) => l.trim() !== ""),
        ],
        facts: [
          ...(c.taxId ? ([[t("vatNumber"), c.taxId]] as Array<[string, string]>) : []),
          ...(c.crNumber ? ([[t("crNumber"), c.crNumber]] as Array<[string, string]>) : []),
        ],
      },
      details: [
        [t("invoiceDate"), f.date(inv.invoiceDate)],
        ...(inv.dueDate ? ([[t("dueDate"), f.date(inv.dueDate)]] as Array<[string, string]>) : []),
        [t("salesOrder"), inv.delivery.order.number],
        ...(inv.delivery.order.customerRef
          ? ([[t("yourReference"), inv.delivery.order.customerRef]] as Array<[string, string]>)
          : []),
        [t("currency"), inv.currency],
        ...(inv.status === "CANCELLED"
          ? ([[t("status"), t("cancelled")]] as Array<[string, string]>)
          : []),
      ],
      columns: [
        { label: "#", width: 5 },
        { label: t("item"), width: 37 },
        { label: t("quantity"), width: 11, align: "right" },
        { label: t("unitPrice"), width: 13, align: "right" },
        { label: t("vatRate"), width: 10, align: "right" },
        { label: t("vat"), width: 11, align: "right" },
        { label: t("amount"), width: 13, align: "right" },
      ],
      rows: inv.lines.map((l) => [
        String(l.lineNo),
        l.description,
        f.quantity(l.quantity),
        f.price(l.unitPrice),
        l.taxRate === null ? "—" : f.percent(l.taxRate),
        f.price(l.taxAmount),
        f.price(l.grossAmount),
      ]),
      totals: [
        [t("net"), f.money(inv.netAmount, inv.currency)],
        [t("vat"), f.money(inv.taxAmount, inv.currency)],
        [t("total"), f.money(inv.grossAmount, inv.currency)],
      ],
      notes: [t("invoiceNote")],
    });
    return pdfResponse(request, pdf, `${inv.number}.pdf`);
  } catch (error) {
    return errorResponse(error);
  }
}
