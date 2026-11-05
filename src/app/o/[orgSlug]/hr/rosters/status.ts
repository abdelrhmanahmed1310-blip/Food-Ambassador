/** Shared display helpers for roster pages (ADR-128). */

export const OUTCOME_TONE = {
  UPCOMING: "neutral",
  IN_PROGRESS: "neutral",
  ON_TIME: "success",
  EXCEPTION: "warning",
  NO_SHOW: "danger",
  INCOMPLETE: "warning",
  ON_LEAVE: "muted",
} as const;

export type OutcomeKey = keyof typeof OUTCOME_TONE;

/** Hours and minutes, e.g. 7:30. */
export const hm = (minutes: number) =>
  `${Math.floor(minutes / 60)}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;

export const outcomeOf = (c: { outcome: string; onLeave: boolean } | null): OutcomeKey | null =>
  c ? (c.onLeave ? "ON_LEAVE" : (c.outcome as OutcomeKey)) : null;
