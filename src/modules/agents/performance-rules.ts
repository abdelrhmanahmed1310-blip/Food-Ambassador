import {
  AUTONOMY_FOR,
  REJECTION_REASONS,
  type AgentKindCode,
  type AutonomyCode,
  type RejectionReason,
} from "./rules";

/**
 * Agent performance (DECISIONS.md ADR-150). Pure: monthly figures per agent
 * from recorded data, their totals, and a readiness hint. Nothing is
 * estimated: no time saved, no value; only what happened.
 */

export interface MonthFigures {
  month: string;
  runs: number;
  failedRuns: number;
  findings: { CRITICAL: number; WARNING: number; INFO: number };
  proposals: number;
  approved: number;
  rejected: number;
  superseded: number;
  open: number;
  actedByAgent: number;
  stopped: number;
  followUpsTaken: number;
  /** Median hours from proposal to a person's decision; null when none was decided. */
  medianDecisionHours: number | null;
  aiTokens: number;
}

export const emptyMonth = (month: string): MonthFigures => ({
  month,
  runs: 0,
  failedRuns: 0,
  findings: { CRITICAL: 0, WARNING: 0, INFO: 0 },
  proposals: 0,
  approved: 0,
  rejected: 0,
  superseded: 0,
  open: 0,
  actedByAgent: 0,
  stopped: 0,
  followUpsTaken: 0,
  medianDecisionHours: null,
  aiTokens: 0,
});

/** The months ending with `month` (YYYY-MM), oldest first. */
export function monthsBack(month: string, count: number): string[] {
  const [y, m] = month.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

/** A decision is enough to judge an agent from this many decided proposals. */
export const READINESS_MIN_DECISIONS = 20;
export const READINESS_APPROVAL_PERCENT = 90;

export interface AgentSummary {
  kind: AgentKindCode;
  months: MonthFigures[];
  totals: Omit<MonthFigures, "month" | "medianDecisionHours">;
  /** Approved ÷ (approved + rejected) by people, whole percent; null when nothing was decided. */
  approvalPercent: number | null;
  /**
   * READY: enough decisions, nearly all approved, none rejected in the last month;
   * MIXED: enough decisions, not that; TOO_FEW: not enough to say.
   */
  readiness: "READY" | "MIXED" | "TOO_FEW";
}

export function summarize(kind: AgentKindCode, months: MonthFigures[]): AgentSummary {
  const totals = months.reduce(
    (a, m) => ({
      runs: a.runs + m.runs,
      failedRuns: a.failedRuns + m.failedRuns,
      findings: {
        CRITICAL: a.findings.CRITICAL + m.findings.CRITICAL,
        WARNING: a.findings.WARNING + m.findings.WARNING,
        INFO: a.findings.INFO + m.findings.INFO,
      },
      proposals: a.proposals + m.proposals,
      approved: a.approved + m.approved,
      rejected: a.rejected + m.rejected,
      superseded: a.superseded + m.superseded,
      open: a.open + m.open,
      actedByAgent: a.actedByAgent + m.actedByAgent,
      stopped: a.stopped + m.stopped,
      followUpsTaken: a.followUpsTaken + m.followUpsTaken,
      aiTokens: a.aiTokens + m.aiTokens,
    }),
    {
      ...emptyMonth(""),
      month: undefined,
      medianDecisionHours: undefined,
    } as unknown as AgentSummary["totals"],
  );
  const decided = totals.approved + totals.rejected;
  const approvalPercent = decided === 0 ? null : Math.round((totals.approved / decided) * 100);
  const last = months.at(-1);
  const readiness =
    decided < READINESS_MIN_DECISIONS || approvalPercent === null
      ? "TOO_FEW"
      : approvalPercent >= READINESS_APPROVAL_PERCENT && (last?.rejected ?? 0) === 0
        ? "READY"
        : "MIXED";
  return { kind, months, totals, approvalPercent, readiness };
}

/**
 * What an owner may do from an agent's record (ADR-151): raise a switched-on
 * agent to act within limits where that is offered, or take it back to
 * proposing. Raising on a record that is not READY needs the owner to say
 * they have read it; the record guides, it does not decide.
 */
export type TrustStep =
  | { step: "RAISE"; to: "ACT"; acknowledgementNeeded: boolean }
  | { step: "LOWER"; to: AutonomyCode }
  | { step: "NONE"; reason: "NOT_OFFERED" | "OFF" };

/** The highest autonomy below acting that the agent offers. */
export function proposingAutonomy(kind: AgentKindCode): AutonomyCode {
  const offered = AUTONOMY_FOR[kind].filter((a) => a !== "ACT");
  return offered.at(-1) ?? "SUGGEST";
}

export function trustStep(
  kind: AgentKindCode,
  agent: { enabled: boolean; autonomy: AutonomyCode } | null,
  readiness: AgentSummary["readiness"],
): TrustStep {
  if (!AUTONOMY_FOR[kind].includes("ACT")) return { step: "NONE", reason: "NOT_OFFERED" };
  if (!agent || !agent.enabled) return { step: "NONE", reason: "OFF" };
  if (agent.autonomy === "ACT") return { step: "LOWER", to: proposingAutonomy(kind) };
  return { step: "RAISE", to: "ACT", acknowledgementNeeded: readiness !== "READY" };
}

/** A rejection reason as counted; NOT_RECORDED for rejections before ADR-152. */
export type CountedReason = RejectionReason | "NOT_RECORDED";

/**
 * Why people rejected an agent's proposals (ADR-152): most frequent first,
 * ties in the order of the list, rejections without a reason last.
 */
export function rankReasons(
  rows: ReadonlyArray<{ reason: string | null; count: number }>,
): Array<{ reason: CountedReason; count: number }> {
  const order: readonly CountedReason[] = [...REJECTION_REASONS, "NOT_RECORDED"];
  const counts = new Map<CountedReason, number>();
  for (const r of rows) {
    const key: CountedReason =
      r.reason && (REJECTION_REASONS as readonly string[]).includes(r.reason)
        ? (r.reason as RejectionReason)
        : "NOT_RECORDED";
    counts.set(key, (counts.get(key) ?? 0) + r.count);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) =>
      a.reason === "NOT_RECORDED" || b.reason === "NOT_RECORDED"
        ? Number(a.reason === "NOT_RECORDED") - Number(b.reason === "NOT_RECORDED")
        : b.count - a.count || order.indexOf(a.reason) - order.indexOf(b.reason),
    );
}
