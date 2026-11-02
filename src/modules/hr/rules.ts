/** HR rules (DECISIONS.md ADR-079). Pure; no I/O. */

/** Documents expiring within this many days are flagged. */
export const EXPIRY_WARNING_DAYS = 30;

export type DocumentState = "EXPIRED" | "EXPIRING" | "VALID" | "NO_EXPIRY";

/** A document's state on a calendar day (YYYY-MM-DD); it is valid on its expiry day. */
export function documentState(expiresOn: string | null, today: string): DocumentState {
  if (!expiresOn) return "NO_EXPIRY";
  if (expiresOn < today) return "EXPIRED";
  const warnUntil = new Date(`${today}T00:00:00Z`);
  warnUntil.setUTCDate(warnUntil.getUTCDate() + EXPIRY_WARNING_DAYS);
  return expiresOn <= warnUntil.toISOString().slice(0, 10) ? "EXPIRING" : "VALID";
}

/**
 * Would making `managerId` the manager of `employeeId` create a loop? Walks
 * up from the proposed manager; `managerOf` gives each person's manager.
 */
export function createsReportingLoop(
  employeeId: string,
  managerId: string | null,
  managerOf: ReadonlyMap<string, string | null>,
): boolean {
  const seen = new Set<string>();
  let current = managerId;
  while (current) {
    if (current === employeeId) return true;
    if (seen.has(current)) return true; // an existing loop: refuse rather than spin
    seen.add(current);
    current = managerOf.get(current) ?? null;
  }
  return false;
}

export interface OrgNode<T> {
  person: T;
  reports: OrgNode<T>[];
}

/**
 * The reporting tree: people whose manager is not among `people` (or who
 * have none) are roots. Sorted by the given key at every level.
 */
export function orgTree<T extends { id: string; managerId: string | null }>(
  people: readonly T[],
  sortKey: (p: T) => string,
): OrgNode<T>[] {
  const ids = new Set(people.map((p) => p.id));
  const byManager = new Map<string | null, T[]>();
  for (const p of people) {
    const key = p.managerId && ids.has(p.managerId) ? p.managerId : null;
    byManager.set(key, [...(byManager.get(key) ?? []), p]);
  }
  const build = (managerId: string | null, depth: number): OrgNode<T>[] =>
    depth > 50
      ? []
      : [...(byManager.get(managerId) ?? [])]
          .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
          .map((person) => ({ person, reports: build(person.id, depth + 1) }));
  return build(null, 0);
}
