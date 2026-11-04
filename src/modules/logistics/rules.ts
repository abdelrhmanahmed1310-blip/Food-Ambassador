import { Decimal, type DecimalInput } from "@/lib/decimal";

/**
 * Own fleet: trips, proof of delivery and cold chain (DECISIONS.md ADR-116). Pure.
 */

export const VEHICLE_TYPES = ["VAN", "TRUCK", "CAR", "MOTORBIKE", "OTHER"] as const;

/** Outside the vehicle's range (refrigerated vehicles only; the limits themselves are within range). */
export function isExcursion(
  temperatureC: DecimalInput,
  range: { min: DecimalInput | null; max: DecimalInput | null },
): boolean {
  if (range.min === null || range.max === null) return false;
  const t = new Decimal(temperatureC);
  return t.lt(range.min) || t.gt(range.max);
}

/**
 * A drawn signature as SVG path data: only move/line commands and numbers,
 * so nothing but a line can be stored or rendered. Coordinates are rounded
 * to whole units of the 300 × 120 pad.
 */
export function normalizeSignature(raw: string): string {
  return raw
    .trim()
    .replace(/(-?\d+(?:\.\d+)?)/g, (n) => String(Math.round(Number(n))))
    .replace(/\s+/g, " ");
}

export const isValidSignature = (raw: string) => {
  const d = raw.trim();
  return (
    d.length <= 20_000 && /^(?:[ML]\s*-?\d{1,4}(?:\.\d+)?[ ,]+-?\d{1,4}(?:\.\d+)?\s*)+$/.test(d)
  );
};

/** Kilometres driven, from the odometer readings. */
export function distanceKm(start: number | null, end: number | null): number | null {
  if (start === null || end === null || end < start) return null;
  return end - start;
}

/** A trip completes when every stop has a proof of delivery or a recorded failure. */
export const allStopsResolved = (stops: ReadonlyArray<{ status: string }>) =>
  stops.length > 0 && stops.every((s) => s.status !== "PENDING");
