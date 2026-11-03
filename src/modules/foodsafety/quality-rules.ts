/**
 * Audits and complaints (DECISIONS.md ADR-098). Pure; no I/O.
 */

export type FindingSeverity = "OBSERVATION" | "MINOR" | "MAJOR" | "CRITICAL";
export type NcSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** The non-conformance an audit finding opens; an observation opens none. */
export function ncSeverityForFinding(severity: FindingSeverity): NcSeverity | null {
  switch (severity) {
    case "OBSERVATION":
      return null;
    case "MINOR":
      return "MEDIUM";
    case "MAJOR":
      return "HIGH";
    case "CRITICAL":
      return "CRITICAL";
  }
}

export type ComplaintCategory =
  | "FOREIGN_OBJECT"
  | "ILLNESS"
  | "ALLERGEN"
  | "QUALITY"
  | "TEMPERATURE"
  | "HYGIENE"
  | "SERVICE"
  | "OTHER";

/** Complaints that may mean unsafe food: always investigated as a HIGH non-conformance. */
export const FOOD_SAFETY_COMPLAINTS: ReadonlySet<ComplaintCategory> = new Set([
  "FOREIGN_OBJECT",
  "ILLNESS",
  "ALLERGEN",
]);

export const isFoodSafetyComplaint = (c: ComplaintCategory) => FOOD_SAFETY_COMPLAINTS.has(c);

/** Counts per finding severity, highest first (the audit summary). */
export function findingCounts(severities: readonly FindingSeverity[]) {
  const order: FindingSeverity[] = ["CRITICAL", "MAJOR", "MINOR", "OBSERVATION"];
  return order.map((s) => ({ severity: s, count: severities.filter((x) => x === s).length }));
}
