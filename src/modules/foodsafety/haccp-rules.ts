/**
 * HACCP rules (DECISIONS.md ADR-096). Pure; no I/O.
 *
 * The decision tree is the Codex Alimentarius one (General Principles of
 * Food Hygiene, HACCP annex). As in ISO 22000, a significant hazard that is
 * not controlled at a CCP is controlled by an operational prerequisite
 * programme (OPRP); a hazard that is not significant is left to the
 * prerequisite programmes (PRP).
 */

export type ControlClass = "CCP" | "OPRP" | "PRP";

export interface TreeAnswers {
  /** Do control measures exist for the hazard (at this or a later step)? */
  q1: boolean | null;
  /** Is the step specifically designed to eliminate the hazard or reduce it to an acceptable level? */
  q2: boolean | null;
  /** Could contamination occur at, or increase to, unacceptable levels? */
  q3: boolean | null;
  /** Will a later step eliminate the hazard or reduce it to an acceptable level? */
  q4: boolean | null;
}

export type TreeOutcome =
  | { result: ControlClass; asked: Array<keyof TreeAnswers> }
  /** Control is needed but none exists: the step or process must be changed. */
  | { result: "MODIFY"; asked: Array<keyof TreeAnswers> }
  /** An answer is missing: the next question to ask. */
  | { result: null; next: keyof TreeAnswers; asked: Array<keyof TreeAnswers> };

export function decide(significant: boolean, a: TreeAnswers): TreeOutcome {
  if (!significant) return { result: "PRP", asked: [] };
  if (a.q1 === null) return { result: null, next: "q1", asked: [] };
  if (!a.q1) return { result: "MODIFY", asked: ["q1"] };
  if (a.q2 === null) return { result: null, next: "q2", asked: ["q1"] };
  if (a.q2) return { result: "CCP", asked: ["q1", "q2"] };
  if (a.q3 === null) return { result: null, next: "q3", asked: ["q1", "q2"] };
  if (!a.q3) return { result: "OPRP", asked: ["q1", "q2", "q3"] };
  if (a.q4 === null) return { result: null, next: "q4", asked: ["q1", "q2", "q3"] };
  return { result: a.q4 ? "OPRP" : "CCP", asked: ["q1", "q2", "q3", "q4"] };
}

/** Likelihood × severity, each 1–5, as assessed by the team. */
export const riskScore = (likelihood: number, severity: number) => likelihood * severity;

export type PlanProblem =
  | { code: "NO_STEPS" }
  | { code: "NO_HAZARDS" }
  | { code: "TREE_INCOMPLETE"; hazardId: string }
  | { code: "STEP_NEEDS_CONTROL"; hazardId: string }
  | { code: "CONTROL_POINT_MISSING"; hazardId: string };

/** What stops a draft plan from being approved; empty = ready. */
export function planProblems(plan: {
  steps: number;
  hazards: ReadonlyArray<{
    id: string;
    significant: boolean;
    answers: TreeAnswers;
    classification: ControlClass;
    hasControlPoint: boolean;
  }>;
}): PlanProblem[] {
  const out: PlanProblem[] = [];
  if (plan.steps === 0) out.push({ code: "NO_STEPS" });
  if (plan.hazards.length === 0) out.push({ code: "NO_HAZARDS" });
  for (const h of plan.hazards) {
    const d = decide(h.significant, h.answers);
    if (d.result === null) out.push({ code: "TREE_INCOMPLETE", hazardId: h.id });
    else if (d.result === "MODIFY") out.push({ code: "STEP_NEEDS_CONTROL", hazardId: h.id });
    if (h.classification !== "PRP" && !h.hasControlPoint)
      out.push({ code: "CONTROL_POINT_MISSING", hazardId: h.id });
  }
  return out;
}

/**
 * Whether a monitoring point's alarm limits sit inside a control point's
 * critical limits (both °C), so a reading that breaks the critical limit is
 * always out of spec at the checkpoint.
 */
export function checkpointWithinLimits(
  checkpoint: { min: number | null; max: number | null },
  critical: { min: number | null; max: number | null },
): boolean {
  if (critical.min !== null && (checkpoint.min === null || checkpoint.min < critical.min))
    return false;
  if (critical.max !== null && (checkpoint.max === null || checkpoint.max > critical.max))
    return false;
  return true;
}
