import { getTranslations } from "next-intl/server";
import { DescriptionList } from "@/components/ui/primitives";
import { SALES_CHANNELS } from "@/modules/menu/rules";
import type { getShift } from "@/modules/pos/service";
import { moneyFormatter } from "@/server/inventory-view";

type Totals = Awaited<ReturnType<typeof getShift>>["totals"];

/** The X/Z figures of a shift: sales by method and channel, voids, refunds, VAT and cash. */
export async function ShiftTotals({
  totals,
  openingFloat,
  currency,
  counted,
}: {
  totals: Totals;
  openingFloat: { toString(): string };
  currency: string;
  counted?: {
    counted: { toString(): string };
    difference: { toString(): string };
    /** Expected cash as recorded when the shift closed. */
    expected: { toString(): string };
  } | null;
}) {
  const [t, fmt] = await Promise.all([getTranslations(), moneyFormatter(currency)]);
  const m = (v: { toString(): string }) => (
    <span className="ltr-value tabular-nums">{fmt.money(v)}</span>
  );
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <DescriptionList
        items={[
          { label: t("pos.ordersCount"), value: totals.orders },
          { label: t("pos.netSales"), value: m(totals.net) },
          { label: t("pos.vat"), value: m(totals.tax) },
          { label: t("pos.grossSales"), value: m(totals.gross) },
          ...SALES_CHANNELS.map((c) => ({
            label: t(`menu.channels.${c}`),
            value: m(totals.byChannel[c]),
          })),
          {
            label: t("pos.voids"),
            value: (
              <>
                {totals.voids.count} · {m(totals.voids.gross)}
              </>
            ),
          },
          {
            label: t("pos.refunds"),
            value: (
              <>
                {totals.refunds.count} · {m(totals.refunds.amount)}
              </>
            ),
          },
          { label: t("pos.promotions"), value: m(totals.discounts.promotions) },
          {
            label: t("pos.orderDiscounts"),
            value: (
              <>
                {totals.discounts.count} · {m(totals.discounts.orders)}
              </>
            ),
          },
        ]}
      />
      <DescriptionList
        items={[
          { label: t("pos.openingFloatLabel"), value: m(openingFloat) },
          { label: t("pos.cashSales"), value: m(totals.cash.sales) },
          { label: t("pos.cashRefunds"), value: m(totals.cash.refunds) },
          { label: t("pos.movementKinds.PAY_IN"), value: m(totals.payIns) },
          { label: t("pos.movementKinds.PAY_OUT"), value: m(totals.payOuts) },
          {
            label: t("pos.expectedCash"),
            value: <strong>{m(counted ? counted.expected : totals.expectedCash)}</strong>,
          },
          ...(counted
            ? [
                { label: t("pos.countedCashLabel"), value: m(counted.counted) },
                { label: t("pos.difference"), value: <strong>{m(counted.difference)}</strong> },
              ]
            : []),
          ...(totals.late.count > 0
            ? [
                {
                  label: t("pos.lateOrders"),
                  value: (
                    <span data-testid="late-orders">
                      {totals.late.count} · {m(totals.late.gross)}
                    </span>
                  ),
                },
                { label: t("pos.lateCash"), value: m(totals.late.cash) },
              ]
            : []),
          { label: t("pos.cardSales"), value: m(totals.card.sales) },
          { label: t("pos.cardRefunds"), value: m(totals.card.refunds) },
          { label: t("pos.cardTips"), value: m(totals.tips) },
        ]}
      />
    </div>
  );
}
