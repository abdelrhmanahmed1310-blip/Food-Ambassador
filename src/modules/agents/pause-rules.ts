import type { RejectionReason } from "./rules";

/**
 * Rejection reasons tune the agents (DECISIONS.md ADR-155). When people
 * reject an agent's proposal for the same record as "not needed" or "already
 * done" twice within 30 days, the agent stops proposing it for 30 days from
 * the second rejection. Lifted rejections do not count.
 */

export const PAUSING_REASONS: ReadonlySet<RejectionReason> = new Set([
  "NOT_NEEDED",
  "ALREADY_DONE",
]);
export const PAUSE_AFTER_REJECTIONS = 2;
export const PAUSE_DAYS = 30;
const DAY = 86_400_000;

export interface Rejection {
  reason: string | null;
  decidedAt: Date | null;
  pauseLiftedAt: Date | null;
}

/** Until when the agent should not propose this record again, or null. */
export function pausedUntil(rejections: readonly Rejection[], now: Date): Date | null {
  const times = rejections
    .filter(
      (r) =>
        r.decidedAt &&
        !r.pauseLiftedAt &&
        r.reason !== null &&
        PAUSING_REASONS.has(r.reason as RejectionReason),
    )
    .map((r) => r.decidedAt!.getTime())
    .sort((a, b) => a - b);
  let until = 0;
  for (let i = PAUSE_AFTER_REJECTIONS - 1; i < times.length; i++)
    if (times[i] - times[i - (PAUSE_AFTER_REJECTIONS - 1)] <= PAUSE_DAYS * DAY)
      until = Math.max(until, times[i] + PAUSE_DAYS * DAY);
  return until > now.getTime() ? new Date(until) : null;
}

/** How far back rejections can still matter. */
export const PAUSE_LOOKBACK_MS = 2 * PAUSE_DAYS * DAY;
