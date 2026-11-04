import { getLocale, getTranslations } from "next-intl/server";
import { letterheadInTx } from "@/modules/documents/service";
import { getPickList } from "@/modules/wms/picking";
import { withTenantTx } from "@/server/db/transactions";
import { productName } from "@/server/inventory-view";
import { renderPdf, pdfResponse } from "@/server/pdf/document";
import { pdfFormat } from "@/server/pdf/format";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** The packing list of one order: each unit and what is in it (ADR-103). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/inventory/picking/[pickListId]/packing-list">,
) {
  const { orgSlug, pickListId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    const p = await getPickList(ctx, pickListId);
    const seller = await withTenantTx(ctx.organizationId, (tx) => letterheadInTx(tx, ctx, null));
    const [t, locale, f] = await Promise.all([getTranslations("loads"), getLocale(), pdfFormat()]);
    const rows = p.packUnits.flatMap((u) =>
      u.lines.map((x, i) => {
        const line = p.lines.find((l) => l.id === x.pickListLineId)!;
        return [
          i === 0 ? `${u.number}\n${t(`unitTypes.${u.type}`)}` : "",
          `${line.product.sku} — ${productName(line.product, locale)}`,
          `${line.lot?.lotCode ?? "—"}${line.lot?.expiresOn ? `\n${f.date(line.lot.expiresOn)}` : ""}`,
          `${f.quantity(x.quantity)} ${line.product.baseUom.code}`,
          i === 0 && u.grossWeightKg ? `${f.quantity(u.grossWeightKg)} kg` : "",
        ];
      }),
    );
    const pdf = await renderPdf({
      title: t("packingListTitle"),
      number: p.number,
      seller: { name: seller.legalName, lines: seller.address, facts: [] },
      party: {
        label: t("customer"),
        name: `${p.salesOrder.customer.code} — ${p.salesOrder.customer.name}`,
        lines: [p.salesOrder.number],
        facts: [],
      },
      details: [[t("warehouse"), `${p.warehouse.code} — ${p.warehouse.name}`]],
      columns: [
        { label: t("unitNumber"), width: 20 },
        { label: t("product"), width: 36 },
        { label: t("lot"), width: 18 },
        { label: t("quantity"), width: 14, align: "right" },
        { label: t("weight"), width: 12, align: "right" },
      ],
      rows,
      totals: [[t("unitsTotal"), String(p.packUnits.length)]],
      notes: [],
    });
    return pdfResponse(request, pdf, `${p.number}-packing.pdf`);
  } catch (error) {
    return errorResponse(error);
  }
}
