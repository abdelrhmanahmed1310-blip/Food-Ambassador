/** Badge tones for recruitment pages (ADR-129). */
export const OPENING_TONE = {
  PENDING_APPROVAL: "warning",
  OPEN: "success",
  FILLED: "neutral",
  CLOSED: "muted",
  REJECTED: "danger",
} as const;

export const STAGE_TONE = {
  APPLIED: "neutral",
  SCREENING: "neutral",
  INTERVIEW: "warning",
  OFFER: "warning",
  HIRED: "success",
  REJECTED: "muted",
  WITHDRAWN: "muted",
} as const;
