import { getTranslations } from "next-intl/server";
import { purchaseOrderForPrint } from "@/modules/documents/service";
import { renderPdf, pdfResponse } from "@/server/pdf/document";
import { pdfFormat } from "@/server/pdf/format";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** The purchase order as a PDF to send to the supplier (ADR-089). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/purchasing/orders/[orderId]/pdf">,
) {
  const { orgSlug, orderId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    const { order, supplier, seller } = await purchaseOrderForPrint(ctx, orderId);
    const [t, f] = await Promise.all([getTranslations("documents"), pdfFormat()]);
    const pdf = await renderPdf({
      title: t("purchaseOrder"),
      number: order.number,
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
        label: t("supplier"),
        name: supplier.name,
        lines: [
          supplier.code,
          ...(supplier.address ? [supplier.address] : []),
          ...[supplier.phone, supplier.email].filter((v): v is string => !!v),
        ],
        facts: supplier.taxId ? [[t("vatNumber"), supplier.taxId]] : [],
      },
      details: [
        [t("date"), f.date(order.submittedAt ?? order.createdAt)],
        // A revised order says so, so the supplier replaces the earlier copy (ADR-093).
        ...(order.revision > 0
          ? ([[t("revision"), String(order.revision)]] as Array<[string, string]>)
          : []),
        ...(order.expectedOn
          ? ([[t("expectedOn"), f.date(order.expectedOn)]] as Array<[string, string]>)
          : []),
        [t("deliverTo"), `${order.warehouse.code} — ${order.warehouse.name}`],
        [t("currency"), order.currency],
        [t("status"), t(`poStatuses.${order.status}`)],
      ],
      columns: [
        { label: "#", width: 5 },
        { label: t("item"), width: 45 },
        { label: t("quantity"), width: 14, align: "right" },
        { label: t("unitPrice"), width: 16, align: "right" },
        { label: t("amount"), width: 20, align: "right" },
      ],
      rows: order.lines.map((l) => [
        String(l.lineNo),
        `${l.product.sku} — ${l.product.nameEn}${l.product.nameAr ? `\n${l.product.nameAr}` : ""}`,
        `${f.quantity(l.quantity)} ${l.uom.code}`,
        f.price(l.unitPrice),
        f.money(l.lineTotal, order.currency),
      ]),
      totals: [[t("total"), f.money(order.totalAmount, order.currency)]],
      notes: [...(order.note ? [order.note] : []), t("poNote")],
    });
    return pdfResponse(request, pdf, `${order.number}.pdf`);
  } catch (error) {
    return errorResponse(error);
  }
}
