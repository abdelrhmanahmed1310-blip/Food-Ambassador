import type { Decimal } from "@/lib/decimal";

/** Food safety rules (DECISIONS.md ADR-035). Pure. */

/** Within the limits, both inclusive; a missing bound does not limit. */
export function withinLimits(value: Decimal, min: Decimal | null, max: Decimal | null): boolean {
  return (
    (min === null || value.greaterThanOrEqualTo(min)) &&
    (max === null || value.lessThanOrEqualTo(max))
  );
}

export type NcStatus = "OPEN" | "INVESTIGATING" | "ACTION_PLANNED" | "CLOSED";
export type ActionStatus = "OPEN" | "DONE" | "VERIFIED";

/** A non-conformance closes only when every corrective action has been verified. */
export function canClose(status: NcStatus, actions: readonly { status: ActionStatus }[]): boolean {
  return status !== "CLOSED" && actions.every((a) => a.status === "VERIFIED");
}

/** Status once an action is added: planning starts unless already further on. */
export function statusAfterActionAdded(status: NcStatus): NcStatus {
  return status === "OPEN" || status === "INVESTIGATING" ? "ACTION_PLANNED" : status;
}

/** Overdue: not done by its due date (dates as YYYY-MM-DD in the branch's time zone). */
export function isOverdue(dueOn: string | null, status: ActionStatus, today: string): boolean {
  return dueOn !== null && status === "OPEN" && dueOn < today;
}

/** Severity of the non-conformance an automatic finding opens. */
export function automaticSeverity(failed: number): "MEDIUM" | "HIGH" {
  return failed > 1 ? "HIGH" : "MEDIUM";
}
