import { Decimal } from "@/lib/decimal";
import { roundToCurrency, taxFromGross, taxFromNet } from "@/modules/tax/rules";

/** Point-of-sale rules (DECISIONS.md ADR-059). Pure; shared by the server and the cashier app. */

export type PaymentMethod = "CASH" | "CARD";

/** A line's amounts: the price is per item as entered (incl. or excl. VAT); no rate = no VAT. */
export function lineAmounts(
  unitPrice: Decimal,
  quantity: Decimal,
  includesTax: boolean,
  rate: Decimal | null,
  currency: string,
) {
  const total = unitPrice.times(quantity);
  if (rate === null) {
    const g = roundToCurrency(total, currency);
    return { net: g, tax: new Decimal(0), gross: g };
  }
  return includesTax ? taxFromGross(total, rate, currency) : taxFromNet(total, rate, currency);
}

export interface PaymentInput {
  method: PaymentMethod;
  amount: Decimal;
  tendered?: Decimal;
}

export type PaymentProblem =
  | "PAYMENT_TOTAL_MISMATCH"
  | "PAYMENT_TENDERED_TOO_LOW"
  | "PAYMENT_CHANGE_ON_CARD"
  | "PAYMENT_EMPTY";

/**
 * Payments must add up to the order total exactly; cash may be tendered above
 * its amount (the difference is change); card cannot have change.
 */
export function checkPayments(
  total: Decimal,
  payments: readonly PaymentInput[],
): { problems: PaymentProblem[]; change: Decimal } {
  const problems: PaymentProblem[] = [];
  if (payments.length === 0 || payments.some((p) => !p.amount.gt(0)))
    problems.push("PAYMENT_EMPTY");
  const sum = payments.reduce((a, p) => a.plus(p.amount), new Decimal(0));
  if (!sum.equals(total)) problems.push("PAYMENT_TOTAL_MISMATCH");
  let change = new Decimal(0);
  for (const p of payments) {
    if (p.tendered === undefined) continue;
    if (p.method !== "CASH") problems.push("PAYMENT_CHANGE_ON_CARD");
    else if (p.tendered.lt(p.amount)) problems.push("PAYMENT_TENDERED_TOO_LOW");
    else change = change.plus(p.tendered.minus(p.amount));
  }
  return { problems: [...new Set(problems)], change };
}

/** Cash that should be in the drawer at the end of a shift. */
export function expectedCash(input: {
  openingFloat: Decimal;
  cashSales: Decimal;
  cashRefunds: Decimal;
  payIns: Decimal;
  payOuts: Decimal;
}): Decimal {
  return input.openingFloat
    .plus(input.cashSales)
    .minus(input.cashRefunds)
    .plus(input.payIns)
    .minus(input.payOuts);
}

/**
 * The share of a line given back when `quantity` of it is refunded. The last
 * part refunded takes what is left, so rounding never refunds more or less
 * than was paid in total.
 */
export function refundPortion(
  line: { quantity: Decimal; gross: Decimal; tax: Decimal },
  already: { quantity: Decimal; gross: Decimal; tax: Decimal },
  quantity: Decimal,
  currency: string,
): { gross: Decimal; tax: Decimal } | null {
  const remaining = line.quantity.minus(already.quantity);
  if (!quantity.gt(0) || quantity.gt(remaining)) return null;
  if (quantity.equals(remaining))
    return { gross: line.gross.minus(already.gross), tax: line.tax.minus(already.tax) };
  const share = quantity.dividedBy(line.quantity);
  return {
    gross: roundToCurrency(line.gross.times(share), currency),
    tax: roundToCurrency(line.tax.times(share), currency),
  };
}
