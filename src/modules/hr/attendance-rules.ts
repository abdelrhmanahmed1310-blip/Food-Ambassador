/** Attendance rules (DECISIONS.md ADR-080). Pure; no I/O. */

export type PunchKind = "IN" | "OUT";

/** Great-circle distance in metres (haversine). */
export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** A tap clocks in unless the employee's last punch was a clock-in. */
export function nextKind(last: PunchKind | null): PunchKind {
  return last === "IN" ? "OUT" : "IN";
}

/** 4 to 6 digits. */
export const PIN_PATTERN = /^\d{4,6}$/;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MINUTES = 15;

/** The calendar day of an instant in a time zone (YYYY-MM-DD). */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export interface Session {
  in: Date | null;
  out: Date | null;
  minutes: number;
  /** MISSING_OUT: clocked in without clocking out; MISSING_IN: clocked out without clocking in. */
  issue: "MISSING_OUT" | "MISSING_IN" | null;
}

export interface DaySheet {
  day: string;
  sessions: Session[];
  minutes: number;
  issues: number;
}

/**
 * Pairs one employee's punches (any order) into sessions and groups them by
 * the local day they started; a shift past midnight counts for the day it
 * began. A clock-in that is still open at `now` is not an issue yet, and its
 * minutes are not counted. Nothing is guessed: unmatched punches are flagged.
 */
export function timesheet(
  punches: ReadonlyArray<{ kind: PunchKind; at: Date }>,
  timeZone: string,
  now: Date,
): DaySheet[] {
  const sorted = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  const sessions: Session[] = [];
  let open: Date | null = null;
  for (const p of sorted) {
    if (p.kind === "IN") {
      if (open) sessions.push({ in: open, out: null, minutes: 0, issue: "MISSING_OUT" });
      open = p.at;
    } else if (open) {
      sessions.push({
        in: open,
        out: p.at,
        minutes: Math.round((p.at.getTime() - open.getTime()) / 60_000),
        issue: null,
      });
      open = null;
    } else {
      sessions.push({ in: null, out: p.at, minutes: 0, issue: "MISSING_IN" });
    }
  }
  if (open) {
    // Still at work today; an open clock-in from an earlier day was never closed.
    const stale = localDay(open, timeZone) !== localDay(now, timeZone);
    sessions.push({ in: open, out: null, minutes: 0, issue: stale ? "MISSING_OUT" : null });
  }
  const days = new Map<string, DaySheet>();
  for (const s of sessions) {
    const day = localDay((s.in ?? s.out)!, timeZone);
    const d = days.get(day) ?? { day, sessions: [], minutes: 0, issues: 0 };
    d.sessions.push(s);
    d.minutes += s.minutes;
    if (s.issue) d.issues += 1;
    days.set(day, d);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}
