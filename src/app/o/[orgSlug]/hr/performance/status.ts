/** Badge tones for review statuses. */
export const REVIEW_TONE = {
  NOT_STARTED: "muted",
  SELF_DONE: "warning",
  MANAGER_DONE: "warning",
  ACKNOWLEDGED: "warning",
  FINALIZED: "success",
  SKIPPED: "muted",
} as const;
export const CYCLE_TONE = { DRAFT: "muted", OPEN: "warning", CLOSED: "success" } as const;
