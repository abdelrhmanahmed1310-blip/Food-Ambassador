/**
 * Recruitment and workforce planning rules (DECISIONS.md ADR-129). Pure.
 */

export const STAGES = [
  "APPLIED",
  "SCREENING",
  "INTERVIEW",
  "OFFER",
  "HIRED",
  "REJECTED",
  "WITHDRAWN",
] as const;
export type Stage = (typeof STAGES)[number];

export const ACTIVE_STAGES: readonly Stage[] = ["APPLIED", "SCREENING", "INTERVIEW", "OFFER"];
export const CLOSED_STAGES: readonly Stage[] = ["HIRED", "REJECTED", "WITHDRAWN"];

/**
 * Where an application may move by hand. Forward one step or out; HIRED
 * only through a hire, which creates the employee.
 */
const MOVES: Record<Stage, readonly Stage[]> = {
  APPLIED: ["SCREENING", "REJECTED", "WITHDRAWN"],
  SCREENING: ["INTERVIEW", "REJECTED", "WITHDRAWN"],
  INTERVIEW: ["OFFER", "REJECTED", "WITHDRAWN"],
  OFFER: ["REJECTED", "WITHDRAWN"],
  HIRED: [],
  REJECTED: [],
  WITHDRAWN: [],
};
export const allowedMoves = (from: Stage): readonly Stage[] => MOVES[from];

export const CANDIDATE_SOURCES = [
  "REFERRAL",
  "JOB_BOARD",
  "WALK_IN",
  "AGENCY",
  "SOCIAL_MEDIA",
  "OTHER",
] as const;

export const INTERVIEW_KINDS = ["IN_PERSON", "PHONE", "VIDEO", "TRIAL_SHIFT"] as const;
export const RECOMMENDATIONS = ["HIRE", "NO_HIRE", "UNSURE"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

/** Job titles match without regard to case or spacing. */
export const titleKey = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

/** Scorecards on an application: how many, the average rating, and the recommendations. */
export function scorecardSummary(
  cards: ReadonlyArray<{ rating: number | null; recommendation: Recommendation | null }>,
) {
  const done = cards.filter((c) => c.rating !== null);
  const sum = done.reduce((a, c) => a + (c.rating ?? 0), 0);
  const count = (r: Recommendation) => done.filter((c) => c.recommendation === r).length;
  return {
    count: done.length,
    average: done.length ? Math.round((sum / done.length) * 10) / 10 : null,
    hire: count("HIRE"),
    noHire: count("NO_HIRE"),
    unsure: count("UNSURE"),
  };
}

export interface PlanRow {
  branchId: string;
  jobTitle: string;
  planned: number;
  filled: number;
  /** Places still to fill in openings that are open or waiting for approval. */
  inRecruitment: number;
  /** Planned less filled and in recruitment: positive is unfilled, negative is over plan. */
  gap: number;
}

/**
 * The workforce plan against the people in post and the openings being
 * recruited, per branch and job title. Titles with people but no plan
 * show with zero planned.
 */
export function workforceRows(input: {
  positions: ReadonlyArray<{ branchId: string; jobTitle: string; planned: number }>;
  employees: ReadonlyArray<{ branchId: string; jobTitle: string }>;
  openings: ReadonlyArray<{ branchId: string; jobTitle: string; remaining: number }>;
}): PlanRow[] {
  const rows = new Map<string, PlanRow>();
  const row = (branchId: string, jobTitle: string) => {
    const k = `${branchId}|${titleKey(jobTitle)}`;
    let r = rows.get(k);
    if (!r) {
      r = { branchId, jobTitle: jobTitle.trim(), planned: 0, filled: 0, inRecruitment: 0, gap: 0 };
      rows.set(k, r);
    }
    return r;
  };
  for (const p of input.positions) {
    const r = row(p.branchId, p.jobTitle);
    r.jobTitle = p.jobTitle.trim();
    r.planned += p.planned;
  }
  for (const e of input.employees) row(e.branchId, e.jobTitle).filled++;
  for (const o of input.openings) row(o.branchId, o.jobTitle).inRecruitment += o.remaining;
  for (const r of rows.values()) r.gap = r.planned - r.filled - r.inRecruitment;
  return [...rows.values()].sort(
    (a, b) => a.branchId.localeCompare(b.branchId) || a.jobTitle.localeCompare(b.jobTitle),
  );
}

/** Whether a candidate's data is due for erasure: nothing active, and untouched for the retention days. */
export function erasureDue(input: {
  stages: readonly Stage[];
  lastActivityAt: Date;
  retentionDays: number | null;
  now: Date;
}): boolean {
  if (input.retentionDays === null) return false;
  if (input.stages.some((s) => ACTIVE_STAGES.includes(s))) return false;
  return input.now.getTime() - input.lastActivityAt.getTime() > input.retentionDays * 86_400_000;
}
