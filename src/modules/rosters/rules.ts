import { Decimal } from "@/lib/decimal";
import { zonedInstant } from "@/modules/pos/pickup-rules";
import { roundToCurrency } from "@/modules/tax/rules";

/**
 * Roster rules (DECISIONS.md ADR-128). Pure.
 */

const MINUTE = 60_000;
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A shift's start and end as instants; an end at or before the start is the next day. */
export function shiftWindow(day: string, start: string, end: string, timeZone: string) {
  const startsAt = zonedInstant(day, start, timeZone);
  const endDay = end <= start ? addDays(day, 1) : day;
  return { startsAt, endsAt: zonedInstant(endDay, end, timeZone) };
}

/** Scheduled paid minutes: the length less the unpaid break. */
export function paidMinutes(startsAt: Date, endsAt: Date, breakMinutes: number): number {
  return Math.max(0, Math.round((endsAt.getTime() - startsAt.getTime()) / MINUTE) - breakMinutes);
}

export const overlaps = (a0: Date, a1: Date, b0: Date, b1: Date) => a0 < b1 && b0 < a1;

/** The Monday of the week a day falls in. */
export function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return addDays(day, -back);
}

export const weekDays = (monday: string) => Array.from({ length: 7 }, (_, i) => addDays(monday, i));

export interface SessionInput {
  in: Date | null;
  out: Date | null;
  minutes: number;
  issue: string | null;
}

export type ShiftOutcome =
  "UPCOMING" | "IN_PROGRESS" | "ON_TIME" | "EXCEPTION" | "NO_SHOW" | "INCOMPLETE";

export interface ShiftComparison {
  outcome: ShiftOutcome;
  lateMinutes: number;
  earlyMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
  /** Indexes of the sessions this shift took. */
  sessions: number[];
}

/** Sessions count for a shift when they meet it widened by this much on each side. */
export const MATCH_MARGIN_MINUTES = 120;

/**
 * Compare a rostered shift with the clock-ins around it. Lateness and
 * leaving early count beyond the grace minutes; worked time is the matched
 * sessions less the break; overtime is worked time beyond the paid
 * minutes, counted from the minimum. A session missing a clock-in or
 * clock-out makes the shift incomplete — nothing is guessed.
 */
export function compareShift(input: {
  startsAt: Date;
  endsAt: Date;
  breakMinutes: number;
  sessions: readonly SessionInput[];
  now: Date;
  graceMinutes: number;
  overtimeMinimumMinutes: number;
}): ShiftComparison {
  const m = MATCH_MARGIN_MINUTES * MINUTE;
  const from = new Date(input.startsAt.getTime() - m);
  const to = new Date(input.endsAt.getTime() + m);
  const matched = input.sessions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => {
      const a = s.in ?? s.out!;
      const b = s.out ?? s.in!;
      return overlaps(a, new Date(b.getTime() + 1), from, to);
    });
  const empty = {
    lateMinutes: 0,
    earlyMinutes: 0,
    workedMinutes: 0,
    overtimeMinutes: 0,
    sessions: matched.map((x) => x.i),
  };
  if (input.now < input.startsAt && matched.length === 0) return { outcome: "UPCOMING", ...empty };
  if (matched.length === 0)
    return { outcome: input.now < input.endsAt ? "IN_PROGRESS" : "NO_SHOW", ...empty };
  if (matched.some(({ s }) => s.issue)) return { outcome: "INCOMPLETE", ...empty };
  const ins = matched.map(({ s }) => s.in).filter((x): x is Date => !!x);
  const outs = matched.map(({ s }) => s.out).filter((x): x is Date => !!x);
  const open = matched.some(({ s }) => s.in && !s.out);
  const firstIn = new Date(Math.min(...ins.map((d) => d.getTime())));
  const late = Math.round((firstIn.getTime() - input.startsAt.getTime()) / MINUTE);
  const lateMinutes = late > input.graceMinutes ? late : 0;
  if (open) return { outcome: "IN_PROGRESS", ...empty, lateMinutes };
  const lastOut = new Date(Math.max(...outs.map((d) => d.getTime())));
  const early = Math.round((input.endsAt.getTime() - lastOut.getTime()) / MINUTE);
  const earlyMinutes = early > input.graceMinutes ? early : 0;
  const workedMinutes = Math.max(
    0,
    matched.reduce((a, { s }) => a + s.minutes, 0) - input.breakMinutes,
  );
  const extra = workedMinutes - paidMinutes(input.startsAt, input.endsAt, input.breakMinutes);
  const overtimeMinutes = extra >= input.overtimeMinimumMinutes ? extra : 0;
  return {
    outcome: lateMinutes || earlyMinutes ? "EXCEPTION" : "ON_TIME",
    lateMinutes,
    earlyMinutes,
    workedMinutes,
    overtimeMinutes,
    sessions: matched.map((x) => x.i),
  };
}

/**
 * Overtime pay: hours × an hourly rate of monthly pay ÷ (days in the
 * basis × standard daily hours) × the multiplier — all as the organization
 * entered them (nothing statutory is preset).
 */
export function overtimePay(input: {
  minutes: number;
  monthlyBase: Decimal;
  basisDays: number;
  dailyHours: Decimal;
  multiplier: Decimal;
  currency: string;
}): Decimal {
  const hourly = hourlyRate(input.monthlyBase, input.basisDays, input.dailyHours);
  return roundToCurrency(
    hourly.times(input.multiplier).times(new Decimal(input.minutes).dividedBy(60)),
    input.currency,
  );
}

/** A day's due date for an onboarding task: so many days from the start. */
export const dueFrom = (startedOn: string, days: number) => addDays(startedOn, days);

/**
 * Give each clock-in session to one shift: the one it overlaps most, else
 * the nearest within the margin. Two shifts on a day never share a session,
 * so overtime is not counted twice.
 */
export function assignSessions(
  shifts: ReadonlyArray<{ startsAt: Date; endsAt: Date }>,
  sessions: readonly SessionInput[],
): number[][] {
  const out: number[][] = shifts.map(() => []);
  const m = MATCH_MARGIN_MINUTES * MINUTE;
  sessions.forEach((s, i) => {
    const a = (s.in ?? s.out!).getTime();
    const b = (s.out ?? s.in!).getTime();
    let best = -1;
    let score = -Infinity;
    shifts.forEach((sh, k) => {
      const s0 = sh.startsAt.getTime();
      const s1 = sh.endsAt.getTime();
      if (!(a < s1 + m && s0 - m < b + 1)) return;
      const overlap = Math.min(b, s1) - Math.max(a, s0);
      const v = overlap > 0 ? overlap : -Math.min(Math.abs(a - s0), Math.abs(b - s1));
      if (v > score) {
        score = v;
        best = k;
      }
    });
    if (best >= 0) out[best].push(i);
  });
  return out;
}

/** An hourly rate of monthly pay: ÷ (days in the basis × standard daily hours). */
export const hourlyRate = (monthly: Decimal, basisDays: number, dailyHours: Decimal) =>
  monthly.dividedBy(dailyHours.times(basisDays));

/** Days a month is divided by: 30, or the month's own length. */
export function basisDaysFor(basis: "CALENDAR_DAYS" | "THIRTY_DAYS", day: string): number {
  if (basis === "THIRTY_DAYS") return 30;
  const [y, mo] = day.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
