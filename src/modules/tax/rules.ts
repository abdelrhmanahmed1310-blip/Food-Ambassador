import { Decimal } from "@/lib/decimal";
import type { TaxCountry } from "./presets";

/** VAT rules (DECISIONS.md ADR-037). Pure. */

/** Smallest currency unit (SAR, AED, EGP: 2 decimals; BHD, KWD, OMR: 3), from ICU data. */
export function currencyDecimals(currency: string): number {
  return (
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

export const roundToCurrency = (amount: Decimal, currency: string) =>
  amount.toDecimalPlaces(currencyDecimals(currency), Decimal.ROUND_HALF_UP);

/** The rate in effect on a date (YYYY-MM-DD): the latest one not after it. */
export function rateOn(
  rates: ReadonlyArray<{ rate: Decimal; effectiveFrom: string }>,
  date: string,
): Decimal | null {
  const applicable = rates
    .filter((r) => r.effectiveFrom <= date)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return applicable[0]?.rate ?? null;
}

export interface TaxBreakdown {
  net: Decimal;
  tax: Decimal;
  gross: Decimal;
}

/** Tax on a line, rounded to the currency unit; the gross always equals net + tax. */
export function taxFromNet(net: Decimal, rate: Decimal, currency: string): TaxBreakdown {
  const n = roundToCurrency(net, currency);
  const tax = roundToCurrency(n.times(rate), currency);
  return { net: n, tax, gross: n.plus(tax) };
}

/** Split a VAT-inclusive amount: tax = gross × rate ÷ (1 + rate), net = gross − tax. */
export function taxFromGross(gross: Decimal, rate: Decimal, currency: string): TaxBreakdown {
  const g = roundToCurrency(gross, currency);
  const tax = roundToCurrency(g.times(rate).dividedBy(rate.plus(1)), currency);
  return { net: g.minus(tax), tax, gross: g };
}

/**
 * Format check of a VAT registration number (it does not prove the number is
 * registered — only the tax authority can). Saudi: 15 digits starting and
 * ending with 3 (ZATCA BR-KSA-40); UAE and Bahrain: 15 digits; Egypt: 9
 * digits; Oman: format not confirmed, so only letters and digits.
 */
export function vatNumberProblem(country: TaxCountry, value: string): "invalidVatNumber" | null {
  const v = value.replace(/[\s-]/g, "");
  const ok: Record<TaxCountry, boolean> = {
    SA: /^3\d{13}3$/.test(v),
    AE: /^\d{15}$/.test(v),
    BH: /^\d{15}$/.test(v),
    OM: /^[A-Z0-9]{5,20}$/i.test(v),
    EG: /^\d{9}$/.test(v),
    QA: /^[A-Z0-9]{5,20}$/i.test(v),
    KW: /^[A-Z0-9]{5,20}$/i.test(v),
  };
  return ok[country] ? null : "invalidVatNumber";
}
