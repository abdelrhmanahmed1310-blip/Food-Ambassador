import { getLocale, getTranslations } from "next-intl/server";
import { letterheadInTx } from "@/modules/documents/service";
import { getWave } from "@/modules/wms/picking";
import { withTenantTx } from "@/server/db/transactions";
import { productName } from "@/server/inventory-view";
import { renderPdf, pdfResponse } from "@/server/pdf/document";
import { pdfFormat } from "@/server/pdf/format";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** The consolidated wave pick sheet in walk order (ADR-102). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/inventory/picking/waves/[waveId]/pdf">,
) {
  const { orgSlug, waveId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    const w = await getWave(ctx, waveId);
    const seller = await withTenantTx(ctx.organizationId, (tx) => letterheadInTx(tx, ctx, null));
    const [t, locale, f] = await Promise.all([
      getTranslations("picking"),
      getLocale(),
      pdfFormat(),
    ]);
    const pdf = await renderPdf({
      title: t("waveSheetTitle"),
      number: w.number,
      seller: { name: seller.legalName, lines: seller.address, facts: [] },
      details: [
        [t("warehouse"), `${w.warehouse.code} — ${w.warehouse.name}`],
        [t("lists"), w.pickLists.map((l) => `${l.number} (${l.salesOrder.number})`).join(", ")],
      ],
      columns: [
        { label: t("from"), width: 14 },
        { label: t("product"), width: 32 },
        { label: t("lot"), width: 16 },
        { label: t("planned"), width: 14, align: "right" },
        { label: t("forLists"), width: 24 },
      ],
      rows: w.sheet.map((r) => [
        r.locationCode ?? t("noLocation"),
        `${r.product.sku} — ${productName(r.product, locale)}`,
        r.lot?.lotCode ?? "—",
        `${f.quantity(r.quantity)} ${r.product.baseUom.code}`,
        r.lists.join(", "),
      ]),
      totals: [],
      notes: [t("waveSheetNote")],
    });
    return pdfResponse(request, pdf, `${w.number}.pdf`);
  } catch (error) {
    return errorResponse(error);
  }
}
