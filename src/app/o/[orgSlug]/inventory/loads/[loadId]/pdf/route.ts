import { getLocale, getTranslations } from "next-intl/server";
import { letterheadInTx } from "@/modules/documents/service";
import { getLoad } from "@/modules/wms/loading";
import { withTenantTx } from "@/server/db/transactions";
import { productName } from "@/server/inventory-view";
import { renderPdf, pdfResponse } from "@/server/pdf/document";
import { pdfFormat } from "@/server/pdf/format";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** The load manifest: every unit with its order, customer and contents (ADR-103). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/inventory/loads/[loadId]/pdf">,
) {
  const { orgSlug, loadId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    const l = await getLoad(ctx, loadId);
    const seller = await withTenantTx(ctx.organizationId, (tx) => letterheadInTx(tx, ctx, null));
    const [t, locale, f] = await Promise.all([getTranslations("loads"), getLocale(), pdfFormat()]);
    const rows = l.pickLists.flatMap((p) =>
      p.packUnits.map((u) => [
        `${u.number}\n${t(`unitTypes.${u.type}`)}`,
        `${p.salesOrder.number}\n${p.salesOrder.customer.name}${p.salesOrder.customer.address ? `\n${p.salesOrder.customer.address}` : ""}`,
        u.lines
          .map(
            (x) =>
              `${x.pickListLine.product.sku} ${productName(x.pickListLine.product, locale)}${x.pickListLine.lot ? ` (${x.pickListLine.lot.lotCode})` : ""} ${f.quantity(x.quantity)} ${x.pickListLine.product.baseUom.code}`,
          )
          .join("\n"),
        u.grossWeightKg ? `${f.quantity(u.grossWeightKg)} kg` : "",
        u.loadedAt ? "✓" : "",
      ]),
    );
    const pdf = await renderPdf({
      title: t("manifestTitle"),
      number: l.number,
      seller: { name: seller.legalName, lines: seller.address, facts: [] },
      details: [
        [t("warehouse"), `${l.warehouse.code} — ${l.warehouse.name}`],
        [t("vehicle"), l.vehicleRef],
        ...(l.driverName ? ([[t("driver"), l.driverName]] as Array<[string, string]>) : []),
        [t("statusLabel"), t(`statuses.${l.status}`)],
        ...(l.dispatchedAt
          ? ([
              [t("dispatchedAt"), f.date(l.dispatchedAt)],
              [
                t("vehicleTemperature"),
                l.vehicleTemperatureCelsius ? `${l.vehicleTemperatureCelsius.toString()} °C` : "—",
              ],
              [t("seal"), l.sealNumber ?? "—"],
            ] as Array<[string, string]>)
          : []),
      ],
      columns: [
        { label: t("unitNumber"), width: 18 },
        { label: t("orders"), width: 24 },
        { label: t("contents"), width: 38 },
        { label: t("weight"), width: 10, align: "right" },
        { label: t("loadedStatus"), width: 10 },
      ],
      rows,
      totals: [[t("unitsTotal"), String(l.unitCount)]],
      notes: [t("manifestNote")],
    });
    return pdfResponse(request, pdf, `${l.number}.pdf`);
  } catch (error) {
    return errorResponse(error);
  }
}
