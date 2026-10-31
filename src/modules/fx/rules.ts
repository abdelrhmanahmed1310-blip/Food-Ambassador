import { Decimal } from "@/lib/decimal";

/**
 * Foreign currencies (DECISIONS.md ADR-050, Q-05/Q-11). Pure.
 *
 * Documents keep their own currency; every amount also has a base-currency
 * equivalent at the rate fixed on the document's date. A rate is the number
 * of base-currency units for one unit of the foreign currency.
 */

/** Currencies purchasing documents may use (plus the organization's base currency). */
export const DOCUMENT_CURRENCIES = [
  "USD",
  "EUR",
  "SAR",
  "EGP",
  "AED",
  "KWD",
  "QAR",
  "BHD",
  "OMR",
] as const;
export type DocumentCurrency = (typeof DOCUMENT_CURRENCIES)[number];

/** Choices for a document's currency: the base currency first. */
export const currencyChoices = (base: string): string[] => [
  base,
  ...DOCUMENT_CURRENCIES.filter((c) => c !== base),
];

/** A rate older than this many days before the document date is not used. */
export const MAX_RATE_AGE_DAYS = 7;

export const isDocumentCurrency = (c: string, base: string) =>
  c === base || (DOCUMENT_CURRENCIES as readonly string[]).includes(c);

const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export type RatePick =
  | { ok: true; rate: Decimal; rateDate: string }
  | { ok: false; reason: "NO_RATE" | "STALE"; latest?: string };

/**
 * The rate for a document dated `date`: 1 for the base currency, otherwise
 * the latest rate on or before the date, if not older than MAX_RATE_AGE_DAYS.
 */
export function pickRate(
  currency: string,
  base: string,
  rates: ReadonlyArray<{ rateDate: string; rate: Decimal }>,
  date: string,
): RatePick {
  if (currency === base) return { ok: true, rate: new Decimal(1), rateDate: date };
  const latest = rates
    .filter((r) => r.rateDate <= date)
    .sort((a, b) => (a.rateDate < b.rateDate ? 1 : -1))[0];
  if (!latest) return { ok: false, reason: "NO_RATE" };
  if (days(latest.rateDate, date) > MAX_RATE_AGE_DAYS)
    return { ok: false, reason: "STALE", latest: latest.rateDate };
  return { ok: true, rate: latest.rate, rateDate: latest.rateDate };
}

/** Base-currency equivalent of a document amount, rounded to the base currency's unit. */
export function toBase(amount: Decimal, rate: Decimal, baseDecimals: number): Decimal {
  return amount.times(rate).toDecimalPlaces(baseDecimals, Decimal.ROUND_HALF_UP);
}

/** A unit price or cost in base currency (6 decimals, as stored for costs). */
export function unitToBase(price: Decimal, rate: Decimal): Decimal {
  return price.times(rate).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

/**
 * Realised exchange difference when `amount` of an invoice booked at
 * `invoiceRate` is settled at `settlementRate`, in base currency: positive
 * = loss (more base currency paid than booked), negative = gain.
 */
export function realisedDifference(
  amount: Decimal,
  invoiceRate: Decimal,
  settlementRate: Decimal,
  baseDecimals: number,
): Decimal {
  return toBase(amount, settlementRate, baseDecimals).minus(
    toBase(amount, invoiceRate, baseDecimals),
  );
}
