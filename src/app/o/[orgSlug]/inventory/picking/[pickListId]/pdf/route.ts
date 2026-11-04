import { getLocale, getTranslations } from "next-intl/server";
import { letterheadInTx } from "@/modules/documents/service";
import { getPickList } from "@/modules/wms/picking";
import { withTenantTx } from "@/server/db/transactions";
import { productName } from "@/server/inventory-view";
import { renderPdf, pdfResponse } from "@/server/pdf/document";
import { pdfFormat } from "@/server/pdf/format";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** A pick sheet in walk order, with a column to write what was picked (ADR-102). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/inventory/picking/[pickListId]/pdf">,
) {
  const { orgSlug, pickListId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    const p = await getPickList(ctx, pickListId);
    const seller = await withTenantTx(ctx.organizationId, (tx) => letterheadInTx(tx, ctx, null));
    const [t, locale, f] = await Promise.all([
      getTranslations("picking"),
      getLocale(),
      pdfFormat(),
    ]);
    const pdf = await renderPdf({
      title: t("sheetTitle"),
      number: p.number,
      seller: { name: seller.legalName, lines: seller.address, facts: [] },
      party: {
        label: t("order"),
        name: `${p.salesOrder.customer.code} — ${p.salesOrder.customer.name}`,
        lines: [p.salesOrder.number],
        facts: [],
      },
      details: [
        [t("warehouse"), `${p.warehouse.code} — ${p.warehouse.name}`],
        [t("statusLabel"), t(`statuses.${p.status}`)],
        ...(p.wave ? ([[t("wave"), p.wave.number]] as Array<[string, string]>) : []),
      ],
      columns: [
        { label: t("from"), width: 14 },
        { label: t("product"), width: 32 },
        { label: t("lot"), width: 18 },
        { label: t("planned"), width: 14, align: "right" },
        { label: t("picked"), width: 10, align: "right" },
        { label: t("to"), width: 12 },
      ],
      rows: p.walk.map((l) => [
        l.location?.code ?? t("noLocation"),
        `${l.product.sku} — ${productName(l.product, locale)}`,
        `${l.lot?.lotCode ?? "—"}${l.lot?.expiresOn ? `\n${f.date(l.lot.expiresOn)}` : ""}`,
        `${f.quantity(l.plannedQuantity)} ${l.product.baseUom.code}`,
        l.pickedQuantity === null ? "" : f.quantity(l.pickedQuantity),
        l.staging.code,
      ]),
      totals: [],
      notes: [t("sheetNote")],
    });
    return pdfResponse(request, pdf, `${p.number}.pdf`);
  } catch (error) {
    return errorResponse(error);
  }
}
