/**
 * Equipment calibration and maintenance (DECISIONS.md ADR-099). Pure; no I/O.
 */
import { Decimal } from "@/lib/decimal";

/** A measured check passes when the reading is within the tolerance of the reference (inclusive). */
export function calibrationOutcome(
  reference: Decimal,
  reading: Decimal,
  tolerance: Decimal,
): "PASS" | "FAIL" {
  if (tolerance.isNegative()) throw new RangeError("Tolerance cannot be negative");
  return reading.minus(reference).abs().lessThanOrEqualTo(tolerance) ? "PASS" : "FAIL";
}

/** Calendar day `days` after `date` (YYYY-MM-DD). */
export function addCalendarDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The next due date: the one given, else last done + the equipment's interval, else none. */
export function nextDueDate(
  performedOn: string,
  given: string | undefined,
  intervalDays: number | null,
) {
  if (given) return given;
  return intervalDays ? addCalendarDays(performedOn, intervalDays) : null;
}

/** Flagged this many days before it is due (the same window as documents, ADR-079/091). */
export const DUE_WARNING_DAYS = 30;

export type DueState = "OVERDUE" | "DUE_SOON" | "OK" | "NOT_PLANNED";

export function dueState(nextDueOn: string | null, today: string): DueState {
  if (!nextDueOn) return "NOT_PLANNED";
  if (nextDueOn < today) return "OVERDUE";
  return nextDueOn <= addCalendarDays(today, DUE_WARNING_DAYS) ? "DUE_SOON" : "OK";
}
