/**
 * Job runner rules (DECISIONS.md ADR-087). Pure and unit-tested.
 */

/** Seconds before retry `attempt` (1-based): 1 min, 5 min, 30 min, 2 h, 12 h. */
export function jobRetryDelaySeconds(attempt: number): number {
  const schedule = [60, 300, 1800, 7200, 43200];
  return schedule[Math.min(Math.max(attempt, 1), schedule.length) - 1];
}

/** A running job not finished after this long is taken as crashed and queued again. */
export const STALE_AFTER_MINUTES = 15;

/** The slot a recurring job belongs to: one job per slot, however often the scheduler runs. */
export function slotKey(now: Date, everyMinutes: number): string {
  const slot = Math.floor(now.getTime() / (everyMinutes * 60_000)) * everyMinutes * 60_000;
  return new Date(slot).toISOString().slice(0, 16);
}

/** The local date and hour in a time zone. */
export function localDateHour(now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The daily digest goes out once the organization's day has reached this hour. */
export const DIGEST_HOUR = 6;
