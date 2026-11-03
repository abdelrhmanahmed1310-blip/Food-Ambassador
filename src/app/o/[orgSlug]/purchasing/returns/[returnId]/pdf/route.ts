import { getTranslations } from "next-intl/server";
import { letterheadForWarehouse } from "@/modules/documents/service";
import { getSupplierReturn } from "@/modules/procurement/returns";
import { renderPdf, pdfResponse } from "@/server/pdf/document";
import { pdfFormat } from "@/server/pdf/format";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** Goods return note for the supplier (ADR-094): what goes back, from which receipts, at which price. */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/purchasing/returns/[returnId]/pdf">,
) {
  const { orgSlug, returnId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    const { ret, supplier, lines } = await getSupplierReturn(ctx, returnId);
    const seller = await letterheadForWarehouse(ctx, ret.warehouseId);
    const [t, tr, f] = await Promise.all([
      getTranslations("documents"),
      getTranslations("returns"),
      pdfFormat(),
    ]);
    const pdf = await renderPdf({
      title: t("returnNote"),
      number: ret.number,
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
        [t("date"), f.date(ret.postedAt ?? ret.createdAt)],
        [t("returnFrom"), `${ret.warehouse.code} — ${ret.warehouse.name}`],
        [t("returnReason"), tr(`reasons.${ret.reason}`)],
        [t("currency"), ret.currency],
        [t("status"), tr(`statuses.${ret.status}`)],
      ],
      columns: [
        { label: "#", width: 5 },
        { label: t("item"), width: 41 },
        { label: t("quantity"), width: 16, align: "right" },
        { label: t("unitPrice"), width: 18, align: "right" },
        { label: t("amount"), width: 20, align: "right" },
      ],
      rows: lines.map((l) => [
        String(l.lineNo),
        `${l.product.sku} — ${l.product.nameEn}${l.product.nameAr ? `\n${l.product.nameAr}` : ""}\n${
          l.receiptLine.receipt.number
        }${l.receiptLine.lot ? ` · ${l.receiptLine.lot.lotCode}` : ""}`,
        `${f.quantity(l.quantity)} ${l.uom.code}`,
        f.price(l.unitPrice),
        f.money(l.lineTotal, ret.currency),
      ]),
      totals: [[t("expectedCredit"), f.money(ret.totalAmount, ret.currency)]],
      notes: [...(ret.note ? [ret.note] : []), t("returnNoteText")],
    });
    return pdfResponse(request, pdf, `${ret.number}.pdf`);
  } catch (error) {
    return errorResponse(error);
  }
}
