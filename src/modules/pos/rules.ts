import { Decimal } from "@/lib/decimal";
import { currencyDecimals, roundToCurrency, taxFromGross, taxFromNet } from "@/modules/tax/rules";

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

/** Clock difference tolerated between a device and the server. */
export const CLOCK_TOLERANCE_MS = 5 * 60_000;

export type OrderTimeProblem = "ORDER_TIME_OUTSIDE_SHIFT" | "MENU_TIME_INVALID";

/**
 * When an order may be recorded in a shift (ADR-060): taken while the shift
 * was open — after it opened and, for a shift already closed, before it
 * closed (an order queued offline and synced late). The menu the device
 * priced it with must have been loaded during the shift and before the order.
 */
export function orderTimeProblem(input: {
  orderedAt: Date;
  menuAsOf: Date;
  now: Date;
  openedAt: Date;
  closedAt: Date | null;
}): OrderTimeProblem | null {
  const t = CLOCK_TOLERANCE_MS;
  const { orderedAt, menuAsOf, now, openedAt, closedAt } = input;
  if (orderedAt.getTime() > now.getTime() + t) return "ORDER_TIME_OUTSIDE_SHIFT";
  if (orderedAt.getTime() < openedAt.getTime() - t) return "ORDER_TIME_OUTSIDE_SHIFT";
  if (closedAt && orderedAt.getTime() > closedAt.getTime()) return "ORDER_TIME_OUTSIDE_SHIFT";
  if (menuAsOf.getTime() > now.getTime() + t) return "MENU_TIME_INVALID";
  if (menuAsOf.getTime() > orderedAt.getTime() + t) return "MENU_TIME_INVALID";
  if (menuAsOf.getTime() < openedAt.getTime() - t) return "MENU_TIME_INVALID";
  return null;
}

/** Whether something archived at `archivedAt` was still on sale on a menu loaded at `asOf`. */
export function liveAt(archivedAt: Date | null, asOf: Date): boolean {
  return archivedAt === null || archivedAt.getTime() > asOf.getTime();
}

export type SyncOutcome = "recorded" | "refused" | "retry" | "signedOut";

/**
 * What the device does with a sync response: keep a queued order until the
 * server has it (or a duplicate says it already does), set it aside with the
 * reason when the server refuses it, and keep retrying on network or server
 * errors. A sign-in page, 401 or 403 (signed out, or someone else signed in)
 * pauses syncing; nothing is dropped.
 */
export function syncOutcome(status: number | null, json: boolean): SyncOutcome {
  if (status === null || status >= 500 || status === 429) return "retry";
  if (status === 401 || status === 403 || !json) return "signedOut";
  if (status === 200 || status === 409) return "recorded";
  return "refused";
}

// ─── Checks (POS2a, ADR-062) ───

export interface CheckLineState {
  status: "PENDING" | "SENT" | "VOIDED";
  quantity: Decimal;
  paidQuantity: Decimal;
}

/** What is still to pay on a check line (nothing on a voided one). */
export function remainingQuantity(line: CheckLineState): Decimal {
  return line.status === "VOIDED" ? new Decimal(0) : line.quantity.minus(line.paidQuantity);
}

/** A check is settled when it has items and every one not voided is fully paid. */
export function checkSettled(lines: readonly CheckLineState[]): boolean {
  const live = lines.filter((l) => l.status !== "VOIDED");
  return live.length > 0 && live.every((l) => remainingQuantity(l).isZero());
}

/**
 * Split an amount into `parts` payments in the currency's smallest unit; the
 * first parts take the extra cents so the parts always add up exactly.
 */
export function splitEvenly(total: Decimal, parts: number, currency: string): Decimal[] {
  if (!Number.isInteger(parts) || parts < 1 || parts > 50) throw new RangeError("parts");
  const step = new Decimal(10).pow(-currencyDecimals(currency));
  const units = total.div(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const base = units.divToInt(parts);
  const extra = units.minus(base.times(parts)).toNumber();
  return Array.from({ length: parts }, (_, i) => base.plus(i < extra ? 1 : 0).times(step));
}
