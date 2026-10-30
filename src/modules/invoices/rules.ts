import { Decimal, roundMoney } from "@/lib/decimal";

/** 3-way match rules (DECISIONS.md ADR-038). Pure. */

export type LineMatch = "MATCHED" | "PRICE_VARIANCE" | "QUANTITY_VARIANCE" | "PRICE_AND_QUANTITY";

/**
 * Match an invoice goods line against what was ordered and received.
 * `openBase` = accepted on the receipt line − already on other invoices.
 * Quantity: invoicing more than is open is a variance. Price: the invoice
 * unit price may differ from the order price by at most `tolerance` (a
 * fraction of the order price).
 */
export function matchGoodsLine(input: {
  openBase: Decimal;
  invoicedBase: Decimal;
  quantity: Decimal;
  invoicePrice: Decimal;
  orderPrice: Decimal;
  tolerance: Decimal;
}): { match: LineMatch; quantityVariance: Decimal; priceVariance: Decimal } {
  const quantityVariance = Decimal.max(input.invoicedBase.minus(input.openBase), 0);
  const priceDiff = input.invoicePrice.minus(input.orderPrice);
  const priceOk = priceDiff.abs().lte(input.orderPrice.times(input.tolerance));
  const qtyOk = quantityVariance.isZero();
  const match: LineMatch =
    qtyOk && priceOk
      ? "MATCHED"
      : !qtyOk && !priceOk
        ? "PRICE_AND_QUANTITY"
        : qtyOk
          ? "PRICE_VARIANCE"
          : "QUANTITY_VARIANCE";
  return { match, quantityVariance, priceVariance: roundMoney(priceDiff.times(input.quantity)) };
}

/** The printed total must equal the computed total to the currency unit. */
export function totalMatches(printed: Decimal, computed: Decimal, decimals: number): boolean {
  return printed
    .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
    .equals(computed.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP));
}

/** Due date from the supplier's payment terms (days), or none. */
export function dueDateFor(invoiceDate: string, termsDays: number | null): string | null {
  if (termsDays === null) return null;
  const d = new Date(`${invoiceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + termsDays);
  return d.toISOString().slice(0, 10);
}

export function invoiceMatchStatus(
  lines: ReadonlyArray<{ match: string }>,
  totalOk: boolean,
): "MATCHED" | "EXCEPTION" {
  return totalOk && lines.every((l) => l.match === "MATCHED" || l.match === "NOT_APPLICABLE")
    ? "MATCHED"
    : "EXCEPTION";
}
