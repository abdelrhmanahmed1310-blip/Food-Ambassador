import { getLocale, getTranslations } from "next-intl/server";
import { isUuid } from "@/lib/uuid";
import { assertPermission } from "@/modules/access/authorize";
import { letterheadInTx } from "@/modules/documents/service";
import { businessDate } from "@/modules/inventory/rules";
import { traceLotInTx } from "@/modules/traceability/trace";
import { withTenantTx } from "@/server/db/transactions";
import { notFound } from "@/server/errors";
import { productName } from "@/server/inventory-view";
import { renderPdf, pdfResponse } from "@/server/pdf/document";
import { pdfFormat } from "@/server/pdf/format";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

const MAX_ROWS = 500;

/**
 * One-click batch report (ADR-100): the lot, where it came from, every
 * recorded movement, what it was made from and went into, shipments,
 * recalls and the gaps in its trace. Built from recorded facts only.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/traceability/lots/[lotId]/pdf">,
) {
  const { orgSlug, lotId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    assertPermission(ctx.grants, "traceability.view");
    if (!isUuid(lotId)) throw notFound("Lot");
    const { trace, seller } = await withTenantTx(ctx.organizationId, async (tx) => ({
      trace: await traceLotInTx(tx, ctx, lotId),
      seller: await letterheadInTx(tx, ctx, null),
    }));
    const [t, tm, tt, locale, f] = await Promise.all([
      getTranslations("trace.pdf"),
      getTranslations("inventory.movementTypes"),
      getTranslations("trace.gaps"),
      getLocale(),
      pdfFormat(),
    ]);
    const { lot } = trace;
    const unit = lot.product.baseUom.code;
    const q = (v: { toString(): string }) => `${f.quantity(v)} ${unit}`;
    const time = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: ctx.timeZone,
    });
    const when = (d: Date) => `${businessDate(ctx.timeZone, d)} ${time.format(d)}`;
    const suppliers = [
      ...new Map(trace.receipts.map((r) => [r.receipt.supplier.id, r.receipt])).values(),
    ];
    const notes: string[] = [];
    if (suppliers.length > 0)
      notes.push(
        `${t("suppliers")}: ${trace.receipts
          .map(
            (r) =>
              `${r.receipt.supplier.code} ${r.receipt.supplier.name} — ${r.receipt.number}${r.receipt.purchaseOrder ? ` / ${r.receipt.purchaseOrder.number}` : ""}${r.receipt.deliveryNoteRef ? ` / ${r.receipt.deliveryNoteRef}` : ""} (${f.date(r.receipt.receivedAt)}, ${f.quantity(r.acceptedQuantity)} ${r.uom.code})`,
          )
          .join("; ")}`,
      );
    if (trace.madeFrom.length > 0)
      notes.push(
        `${t("madeFrom")}: ${trace.madeFrom
          .map(
            (m) =>
              `${m.product.sku} ${m.lot?.lotCode ?? "—"} (${f.quantity(m.quantity)} ${m.product.baseUom.code})`,
          )
          .join("; ")}`,
      );
    if (trace.usedIn.length > 0)
      notes.push(
        `${t("usedIn")}: ${trace.usedIn
          .map((u) => `${u.number} → ${u.outputProduct.sku} ${u.outputLot?.lotCode ?? "—"}`)
          .join("; ")}`,
      );
    if (trace.shipments.length > 0)
      notes.push(
        `${t("shipments")}: ${trace.shipments
          .map(
            (s) =>
              `${s.shipment.number} ${s.shipment.from.code} → ${s.shipment.to.code} (${f.quantity(s.quantityBase)} ${unit})`,
          )
          .join("; ")}`,
      );
    if (trace.recalls.length > 0)
      notes.push(
        `${t("recalls")}: ${trace.recalls.map((r) => `${r.number} ${r.title} (${r.status})`).join("; ")}`,
      );
    notes.push(
      trace.gaps.length === 0
        ? t("noGaps")
        : `${t("gaps")}: ${trace.gaps
            .map((g) =>
              tt(g.kind, { quantity: `${g.quantity} ${unit}`, warehouse: g.entry.warehouse.code }),
            )
            .join(" ")}`,
    );
    if (trace.entries.length > MAX_ROWS) notes.push(t("truncated", { count: MAX_ROWS }));
    notes.push(t("generated", { date: businessDate(ctx.timeZone) }));
    const pdf = await renderPdf({
      title: t("title"),
      number: lot.lotCode,
      seller: { name: seller.legalName, lines: seller.address, facts: [] },
      party: {
        label: t("product"),
        name: `${lot.product.sku} — ${productName(lot.product, locale)}`,
        lines: [],
        facts: [],
      },
      details: [
        [t("lot"), lot.lotCode],
        [t("expires"), lot.expiresOn ? f.date(lot.expiresOn) : "—"],
        [t("received"), q(trace.received)],
        [t("leftBusiness"), q(trace.exited)],
        [t("onHand"), q(trace.onHand)],
        [t("recallHold"), lot.recallHold ? t("yes") : t("no")],
      ],
      columns: [
        { label: t("date"), width: 18 },
        { label: t("movement"), width: 26 },
        { label: t("warehouse"), width: 14 },
        { label: t("document"), width: 24 },
        { label: t("quantity"), width: 18, align: "right" },
      ],
      rows: trace.entries
        .slice(0, MAX_ROWS)
        .map((e) => [
          when(e.occurredAt),
          tm(e.movementType),
          e.warehouse.code,
          e.document.number,
          q(e.quantityDelta),
        ]),
      totals: [],
      notes,
    });
    return pdfResponse(request, pdf, `batch-${lot.lotCode}.pdf`);
  } catch (error) {
    return errorResponse(error);
  }
}
