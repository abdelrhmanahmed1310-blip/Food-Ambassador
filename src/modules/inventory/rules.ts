import { Decimal, toDecimal, type DecimalInput } from "@/lib/decimal";

export const STOCK_STATUSES = ["AVAILABLE", "QUARANTINE", "REJECTED", "ON_HOLD"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** Calendar date (YYYY-MM-DD) at `instant` in an IANA time zone. */
export function businessDate(timeZone: string, instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Add days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A lot is expired once its expiry date is before the business date: stock
 * that expires today is still usable today (DECISIONS.md A-07).
 */
export function isExpired(expiresOn: string | null, today: string): boolean {
  return expiresOn !== null && expiresOn < today;
}

export type ExpiryState = "NONE" | "OK" | "EXPIRING" | "EXPIRED";

export function expiryState(
  expiresOn: string | null,
  today: string,
  warningDays: number,
): ExpiryState {
  if (expiresOn === null) return "NONE";
  if (isExpired(expiresOn, today)) return "EXPIRED";
  return expiresOn <= addDays(today, warningDays) ? "EXPIRING" : "OK";
}

export interface FefoCandidate {
  lotId: string | null;
  expiresOn: string | null;
  bestBeforeOn: string | null;
  firstReceivedAt: Date;
  available: Decimal;
}

const cmpNullableLast = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

/** First-Expired-First-Out order: expiry, then best-before (nulls last), then oldest receipt. */
export function fefoSort<T extends FefoCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort(
    (a, b) =>
      cmpNullableLast(a.expiresOn, b.expiresOn) ||
      cmpNullableLast(a.bestBeforeOn, b.bestBeforeOn) ||
      a.firstReceivedAt.getTime() - b.firstReceivedAt.getTime(),
  );
}

/**
 * Suggest how to pick `requested` from usable lots in FEFO order. Expired and
 * zero-available candidates are skipped. `shortfall` > 0 means not enough stock.
 */
export function fefoAllocate<T extends FefoCandidate>(
  candidates: readonly T[],
  requested: DecimalInput,
  today: string,
) {
  let remaining = toDecimal(requested);
  const picks: Array<{ candidate: T; quantity: Decimal }> = [];
  for (const c of fefoSort(candidates)) {
    if (remaining.lte(0)) break;
    if (isExpired(c.expiresOn, today) || c.available.lte(0)) continue;
    const take = Decimal.min(c.available, remaining);
    picks.push({ candidate: c, quantity: take });
    remaining = remaining.minus(take);
  }
  return { picks, shortfall: Decimal.max(remaining, 0) };
}

/** Count adjustment: counted − expected at snapshot (later movements are already in the balance). */
export function countAdjustment(expectedAtSnapshot: DecimalInput, counted: DecimalInput): Decimal {
  return toDecimal(counted).minus(toDecimal(expectedAtSnapshot));
}

/** Allowed status transitions and the permission each needs (DATA_MODEL.md §4). */
export const STATUS_TRANSITIONS: Record<
  string,
  "inventory.quarantine" | "inventory.quarantine.release"
> = {
  "AVAILABLE>QUARANTINE": "inventory.quarantine",
  "AVAILABLE>ON_HOLD": "inventory.quarantine",
  "QUARANTINE>REJECTED": "inventory.quarantine",
  "ON_HOLD>QUARANTINE": "inventory.quarantine",
  "QUARANTINE>AVAILABLE": "inventory.quarantine.release",
  "ON_HOLD>AVAILABLE": "inventory.quarantine.release",
};

export function transitionPermission(from: StockStatus, to: StockStatus) {
  return STATUS_TRANSITIONS[`${from}>${to}`] ?? null;
}
