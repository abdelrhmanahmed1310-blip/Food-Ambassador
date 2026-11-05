import { createHash } from "node:crypto";

/**
 * Engagement rules (DECISIONS.md ADR-127). Pure.
 */

/** Results stay hidden until at least this many people answered (overall, and per branch). */
export const ANONYMITY_MIN = 5;

export const QUESTION_TYPES = ["RATING", "ENPS", "YES_NO", "TEXT"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const RECOGNITION_VALUES = [
  "TEAMWORK",
  "GUEST_SERVICE",
  "FOOD_SAFETY",
  "CLEANLINESS",
  "LEADERSHIP",
  "EXTRA_MILE",
] as const;

/** The answer a question accepts: 1–5, 0–10, yes (1) / no (0), or text. */
export function validAnswer(
  type: QuestionType,
  value: number | null,
  text: string | null,
): boolean {
  switch (type) {
    case "RATING":
      return value !== null && Number.isInteger(value) && value >= 1 && value <= 5;
    case "ENPS":
      return value !== null && Number.isInteger(value) && value >= 0 && value <= 10;
    case "YES_NO":
      return value === 0 || value === 1;
    case "TEXT":
      return !!text && text.trim().length > 0 && text.length <= 2000;
  }
}

/** Employee net promoter score: % answering 9–10 less % answering 0–6, from −100 to 100. */
export function enps(values: readonly number[]): {
  score: number | null;
  promoters: number;
  passives: number;
  detractors: number;
} {
  const promoters = values.filter((v) => v >= 9).length;
  const detractors = values.filter((v) => v <= 6).length;
  const passives = values.length - promoters - detractors;
  return {
    score: values.length ? Math.round(((promoters - detractors) / values.length) * 100) : null,
    promoters,
    passives,
    detractors,
  };
}

/** Average to two decimals, and how many gave each value. */
export function ratingSummary(values: readonly number[], max = 5) {
  const counts = Array.from({ length: max }, (_, i) => values.filter((v) => v === i + 1).length);
  return {
    average: values.length
      ? Math.round((values.reduce((a, v) => a + v, 0) / values.length) * 100) / 100
      : null,
    counts,
  };
}

export const mayShow = (responses: number) => responses >= ANONYMITY_MIN;

/**
 * Free-text answers in an order that does not follow when they were given
 * (a keyed hash of each answer), so the list cannot be matched to who
 * answered when.
 */
export function shuffled<T extends { id: string }>(rows: readonly T[], key: string): T[] {
  const h = (id: string) => createHash("sha256").update(`${key}:${id}`).digest("hex");
  return [...rows].sort((a, b) => h(a.id).localeCompare(h(b.id)));
}
