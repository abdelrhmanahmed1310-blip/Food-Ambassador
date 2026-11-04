import { Decimal } from "@/lib/decimal";

/**
 * Branch compliance score (DECISIONS.md ADR-100). Pure. Each component is a
 * share of recorded facts (passed / counted); a component with nothing
 * counted has no score instead of a made-up 100 %. The overall score is the
 * plain mean of the components that have one — equal weights, no hidden
 * factors — and is null when none has.
 */

export const COMPLIANCE_COMPONENTS = [
  "RECORDS_IN_SPEC",
  "CHECKLIST_ITEMS_OK",
  "ACTIONS_ON_TIME",
  "EQUIPMENT_CALIBRATED",
] as const;
export type ComplianceComponent = (typeof COMPLIANCE_COMPONENTS)[number];

export interface ComponentCount {
  key: ComplianceComponent;
  passed: number;
  counted: number;
}

export interface ScoredComponent extends ComponentCount {
  /** Whole percent, or null when nothing was counted. */
  percent: number | null;
}

export const COMPLIANCE_PERIODS = [7, 30, 90] as const;

function percent(passed: number, counted: number): Decimal | null {
  if (counted <= 0) return null;
  return new Decimal(Math.min(passed, counted)).div(counted).times(100);
}

export function complianceScore(components: readonly ComponentCount[]): {
  components: ScoredComponent[];
  overall: number | null;
} {
  const exact = components.map((c) => percent(c.passed, c.counted));
  const scored = exact.filter((p): p is Decimal => p !== null);
  const overall =
    scored.length === 0
      ? null
      : scored
          .reduce((a, p) => a.plus(p), new Decimal(0))
          .div(scored.length)
          .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
          .toNumber();
  return {
    components: components.map((c, i) => ({
      ...c,
      percent: exact[i]?.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber() ?? null,
    })),
    overall,
  };
}

/** Bands for display only: 90 + good, 75–89 fair, below 75 poor. */
export function scoreBand(score: number | null): "GOOD" | "FAIR" | "POOR" | "NONE" {
  if (score === null) return "NONE";
  return score >= 90 ? "GOOD" : score >= 75 ? "FAIR" : "POOR";
}
