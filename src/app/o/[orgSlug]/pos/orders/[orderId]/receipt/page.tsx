import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getFormatter, getTranslations } from "next-intl/server";
import { PrintButton } from "@/components/ui/print-button";
import { isUuid } from "@/lib/uuid";
import { getOrder } from "@/modules/pos/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter } from "@/server/inventory-view";

type Option = { optionId: string; name: string; priceDelta: string };

/**
 * Customer receipt sized for 80 mm thermal printers through the browser's
 * print dialog (ADR-057). In Saudi Arabia it carries the ZATCA QR: the signed
 * document's (Phase 2) once the register's unit is onboarded, else Phase 1
 * (seller, VAT number, time, total, VAT) — ADR-064.
 */
export default async function ReceiptPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/orders/[orderId]/receipt">) {
  const { orgSlug, orderId } = await params;
  if (!isUuid(orderId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const [t, format, money, o] = await Promise.all([
    getTranslations(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency),
    notFoundOnAppError(getOrder(ctx, orderId)),
  ]);
  const m = (v: { toString(): string }) => (
    <span className="ltr-value tabular-nums">{money.money(v)}</span>
  );
  const qrSvg = o.eInvoice
    ? await QRCode.toString(o.eInvoice.qr, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
    : null;
  const row = "flex justify-between gap-2";
  return (
    <div className="mx-auto max-w-[80mm] space-y-3 bg-white p-3 font-mono text-xs text-black">
      <style>{"@media print { @page { size: 80mm auto; margin: 3mm; } }"}</style>
      <div className="print:hidden">
        <PrintButton label={t("pos.print")} />
      </div>
      <header className="text-center">
        <p className="text-sm font-bold">{o.organizationName}</p>
        <p>{o.branch.name}</p>
        {o.vatNumber ? <p>{t("pos.vatNumber", { number: o.vatNumber })}</p> : null}
        {o.vatNumber && o.taxAmount.gt(0) ? (
          <p className="font-bold">{t("pos.simplifiedTaxInvoice")}</p>
        ) : null}
      </header>
      <div>
        <p className={row}>
          <span>{o.number}</span>
          <span>
            {format.dateTime(o.orderedAt, {
              dateStyle: "short",
              timeStyle: "short",
              timeZone: o.branch.timeZone ?? ctx.timeZone,
            })}
          </span>
        </p>
        <p>
          {t(`menu.channels.${o.channel}`)} · {o.register.code}
          {o.cashierName ? ` · ${o.cashierName}` : ""}
        </p>
        {o.status === "VOIDED" ? (
          <p className="text-center font-bold">{t("pos.statuses.VOIDED")}</p>
        ) : null}
      </div>
      <ul className="border-y border-dashed border-black py-2">
        {o.lines.map((l) => (
          <li key={l.id}>
            <p className={row}>
              <span>
                {l.quantity.toFixed()} × <bdi>{l.name}</bdi>
              </span>
              {m(l.grossAmount.plus(l.discountAmount))}
            </p>
            {(l.options as Option[]).map((x) => (
              <p key={x.optionId} className="ps-3">
                + <bdi>{x.name}</bdi>
              </p>
            ))}
            {l.discountAmount.gt(0) ? (
              <p className={`${row} ps-3`}>
                <span>{t("pos.discount")}</span>−{m(l.discountAmount)}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="space-y-0.5">
        {o.promoDiscount.gt(0) ? (
          <p className={row}>
            <span>{t("pos.promotions")}</span>−{m(o.promoDiscount)}
          </p>
        ) : null}
        {o.orderDiscount.gt(0) ? (
          <p className={row}>
            <span>
              {o.coupon ? t("pos.couponApplied", { code: o.coupon.code }) : t("pos.discount")}
            </span>
            −{m(o.orderDiscount)}
          </p>
        ) : null}
        {o.taxAmount.gt(0) ? (
          <>
            <p className={row}>
              <span>{t("pos.totalExVat")}</span>
              {m(o.netAmount)}
            </p>
            <p className={row}>
              <span>{t("pos.vat")}</span>
              {m(o.taxAmount)}
            </p>
          </>
        ) : null}
        <p className={`${row} text-sm font-bold`}>
          <span>{t("pos.total")}</span>
          {m(o.grossAmount)}
        </p>
        {o.payments.map((p) => (
          <div key={p.id}>
            <p className={row}>
              <span>{t(`pos.methods.${p.method}`)}</span>
              {m(p.tendered ?? p.amount)}
            </p>
            {p.change && p.change.gt(0) ? (
              <p className={row}>
                <span>{t("pos.change")}</span>
                {m(p.change)}
              </p>
            ) : null}
          </div>
        ))}
        {o.refunds.map((r) => (
          <p key={r.id} className={row}>
            <span>
              {t("pos.refunded")} {r.number}
            </span>
            <span>−{m(r.amount)}</span>
          </p>
        ))}
      </div>
      {qrSvg ? (
        <div
          className="mx-auto w-40"
          data-testid="zatca-qr"
          data-signed={o.eInvoice?.signed ? "1" : "0"}
        >
          {/* SVG drawn by the qrcode library from the ZATCA fields (no user HTML). */}
          <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
        </div>
      ) : null}
      <p className="text-center">{t("pos.thanks")}</p>
    </div>
  );
}
