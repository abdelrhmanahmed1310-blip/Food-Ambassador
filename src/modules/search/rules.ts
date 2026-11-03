/**
 * Global search rules (DECISIONS.md ADR-088). Pure and unit-tested.
 */

export const MIN_QUERY = 2;
export const MAX_QUERY = 80;

/**
 * The text to search for: trimmed, spaces collapsed, between 2 and 80
 * characters; null otherwise. `digits` (4 or more) is used to match phone
 * numbers written with spaces, dashes or a leading +.
 */
export function normalizeQuery(raw: unknown): { text: string; digits: string | null } | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < MIN_QUERY || text.length > MAX_QUERY) return null;
  const digits = text.replace(/[\s()+-]/g, "");
  return { text, digits: /^\d{4,}$/.test(digits) ? digits : null };
}
