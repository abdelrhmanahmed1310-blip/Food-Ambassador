/**
 * Training and certification rules (DECISIONS.md ADR-125). Pure.
 */

export const TRAINING_CATEGORIES = [
  "FOOD_SAFETY",
  "ALLERGENS",
  "HYGIENE",
  "HEALTH_SAFETY",
  "FIRE_SAFETY",
  "FIRST_AID",
  "EQUIPMENT",
  "SERVICE",
  "ONBOARDING",
  "OTHER",
] as const;
export type TrainingCategory = (typeof TRAINING_CATEGORIES)[number];

export const TRAINING_DELIVERIES = ["IN_PERSON", "ONLINE", "ON_THE_JOB"] as const;
export const TRAINING_SCOPES = ["ALL", "JOB_TITLE", "DEPARTMENT", "BRANCH"] as const;
export type TrainingScope = (typeof TRAINING_SCOPES)[number];

/** A certificate expiring within this many days shows as expiring. */
export const TRAINING_WARNING_DAYS = 30;

export type ComplianceStatus = "COMPLIANT" | "EXPIRING" | "EXPIRED" | "DUE" | "OVERDUE";

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/**
 * Expiry of a certificate valid for so many months from completion: the
 * same day that many months on, or the month's last day when it has fewer
 * days (31 January + 1 month = 28 or 29 February). No validity: no expiry.
 */
export function expiryFor(completedOn: string, validityMonths: number | null): string | null {
  if (!validityMonths) return null;
  const [y, m, d] = completedOn.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + validityMonths, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export interface RequirementInput {
  scope: TrainingScope;
  jobTitle: string | null;
  departmentId: string | null;
  branchId: string | null;
}

export interface EmployeeInput {
  jobTitle: string;
  departmentId: string | null;
  branchId: string;
}

/** Job titles match without regard to case or surrounding spaces. */
export function requirementApplies(r: RequirementInput, e: EmployeeInput): boolean {
  switch (r.scope) {
    case "ALL":
      return true;
    case "JOB_TITLE":
      return !!r.jobTitle && r.jobTitle.trim().toLowerCase() === e.jobTitle.trim().toLowerCase();
    case "DEPARTMENT":
      return !!r.departmentId && r.departmentId === e.departmentId;
    case "BRANCH":
      return !!r.branchId && r.branchId === e.branchId;
  }
}

/**
 * Where an employee stands on a required course today: a valid record is
 * compliant (expiring within the warning days); without one they are due
 * until the deadline after hire, then overdue; a record past its expiry is
 * expired.
 */
export function complianceStatus(input: {
  today: string;
  hireDate: string;
  dueWithinDays: number;
  /** The latest valid (not voided, passed) record, if any. */
  latest: { completedOn: string; expiresOn: string | null } | null;
  warningDays?: number;
}): { status: ComplianceStatus; dueOn: string | null; expiresOn: string | null } {
  const warn = input.warningDays ?? TRAINING_WARNING_DAYS;
  if (input.latest) {
    const exp = input.latest.expiresOn;
    if (!exp) return { status: "COMPLIANT", dueOn: null, expiresOn: null };
    // Valid through its expiry day.
    if (exp < input.today) return { status: "EXPIRED", dueOn: null, expiresOn: exp };
    const daysLeft = Math.round((ms(exp) - ms(input.today)) / 86_400_000);
    return {
      status: daysLeft <= warn ? "EXPIRING" : "COMPLIANT",
      dueOn: null,
      expiresOn: exp,
    };
  }
  const dueOn = addDays(input.hireDate, input.dueWithinDays);
  return { status: input.today > dueOn ? "OVERDUE" : "DUE", dueOn, expiresOn: null };
}

/** Pick the record that counts: the one expiring last (no expiry beats any date). */
export function latestRecord<T extends { completedOn: string; expiresOn: string | null }>(
  records: readonly T[],
): T | null {
  let best: T | null = null;
  for (const r of records) {
    if (!best) best = r;
    else if (best.expiresOn === null) continue;
    else if (r.expiresOn === null || r.expiresOn > best.expiresOn) best = r;
    else if (r.expiresOn === best.expiresOn && r.completedOn > best.completedOn) best = r;
  }
  return best;
}
