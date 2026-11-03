import { getTranslations } from "next-intl/server";
import { isUuid } from "@/lib/uuid";
import { letterheadForWarehouse } from "@/modules/documents/service";
import { rfqForSupplier } from "@/modules/procurement/rfqs";
import { renderPdf, pdfResponse } from "@/server/pdf/document";
import { pdfFormat } from "@/server/pdf/format";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** The request for quotation as a PDF for one supplier (ADR-092). Prices are left for the supplier. */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/purchasing/rfqs/[rfqId]/pdf">,
) {
  const { orgSlug, rfqId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  const supplierId = new URL(request.url).searchParams.get("supplierId") ?? "";
  if (!isUuid(supplierId)) return new Response("Not found", { status: 404 });
  try {
    const { rfq, supplier, lines, warehouse } = await rfqForSupplier(ctx, rfqId, supplierId);
    const seller = await letterheadForWarehouse(ctx, rfq.warehouseId);
    const [t, f] = await Promise.all([getTranslations("documents"), pdfFormat()]);
    const pdf = await renderPdf({
      title: t("rfq"),
      number: rfq.number,
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
        [t("date"), f.date(rfq.sentAt ?? rfq.createdAt)],
        ...(rfq.respondBy
          ? ([[t("respondBy"), f.date(rfq.respondBy)]] as Array<[string, string]>)
          : []),
        ...(rfq.neededBy
          ? ([[t("neededBy"), f.date(rfq.neededBy)]] as Array<[string, string]>)
          : []),
        [t("deliverTo"), `${warehouse.code} — ${warehouse.name}`],
      ],
      columns: [
        { label: "#", width: 5 },
        { label: t("item"), width: 45 },
        { label: t("quantity"), width: 16, align: "right" },
        { label: t("unitPrice"), width: 16, align: "right" },
        { label: t("amount"), width: 18, align: "right" },
      ],
      rows: lines.map((l) => [
        String(l.lineNo),
        `${l.product.sku} — ${l.product.nameEn}${l.product.nameAr ? `\n${l.product.nameAr}` : ""}`,
        `${f.quantity(l.quantity)} ${l.uom.code}`,
        "",
        "",
      ]),
      totals: [],
      notes: [rfq.title, ...(rfq.note ? [rfq.note] : []), t("rfqNote")],
    });
    return pdfResponse(request, pdf, `${rfq.number}-${supplier.code}.pdf`);
  } catch (error) {
    return errorResponse(error);
  }
}
