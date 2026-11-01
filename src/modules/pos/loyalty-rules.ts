import { Decimal } from "@/lib/decimal";
import { roundToCurrency } from "@/modules/tax/rules";

/**
 * Customers, loyalty and gift cards (DECISIONS.md ADR-068). Pure; shared by
 * the server and the till.
 */

/** Whole points earned on what the guest paid (after discounts). */
export function pointsEarned(paid: Decimal, earnRate: Decimal): number {
  if (!paid.gt(0) || !earnRate.gt(0)) return 0;
  return paid.times(earnRate).floor().toNumber();
}

/** What points are worth when spent, in the currency. */
export function pointsValue(points: number, pointValue: Decimal, currency: string): Decimal {
  return roundToCurrency(pointValue.times(points), currency);
}

/**
 * Points to take back when part of an order is refunded: the share of the
 * points earned that the refunds so far cover, less what was already taken
 * back — so several refunds never take back more than was earned.
 */
export function pointsToReverse(
  earned: number,
  gross: Decimal,
  refundedBefore: Decimal,
  refundedNow: Decimal,
): number {
  if (earned <= 0 || !gross.gt(0)) return 0;
  const share = (r: Decimal) =>
    new Decimal(earned).times(Decimal.min(r, gross)).div(gross).floor().toNumber();
  return share(refundedBefore.plus(refundedNow)) - share(refundedBefore);
}

/**
 * A phone number in E.164. Saudi numbers may be typed locally (05…, 5…);
 * others need their country code (+…, 00…). Null if it is not a number.
 */
export function normalizePhone(input: string, country: "SA" = "SA"): string | null {
  const raw = input.replace(/[\s\-().]/g, "");
  let e164: string;
  if (raw.startsWith("+")) e164 = raw;
  else if (raw.startsWith("00")) e164 = `+${raw.slice(2)}`;
  else if (country === "SA" && /^05\d{8}$/.test(raw)) e164 = `+966${raw.slice(1)}`;
  else if (country === "SA" && /^5\d{8}$/.test(raw)) e164 = `+966${raw}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

/** Luhn check digit of a digit string. */
function luhnDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/** A gift card code: 15 random digits and a check digit (catches most typing mistakes). */
export function giftCardCode(random15: string): string {
  if (!/^\d{15}$/.test(random15)) throw new Error("15 digits expected");
  return random15 + String(luhnDigit(random15));
}

/** The 16 digits of a typed or scanned code, or null if it is not a valid code. */
export function readGiftCardCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d{16}$/.test(digits)) return null;
  return luhnDigit(digits.slice(0, 15)) === Number(digits[15]) ? digits : null;
}

/** Shown as 4 groups of 4. */
export const formatGiftCardCode = (code: string) => code.replace(/(\d{4})(?=\d)/g, "$1 ");
