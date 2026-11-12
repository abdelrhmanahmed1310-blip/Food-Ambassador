import { Decimal, type DecimalInput } from "@/lib/decimal";

/**
 * Warehouse operation rules (DECISIONS.md ADR-101). Pure.
 */

export type TemperatureZone = "AMBIENT" | "CHILLED" | "FROZEN";
export type LocationZone = "RECEIVING" | "QUARANTINE" | "STORAGE" | "PICKING" | "DISPATCH";

/** Stock is put away into storage or picking locations only. */
export const PUTAWAY_TARGET_ZONES: readonly LocationZone[] = ["STORAGE", "PICKING"];

export interface RuleCandidate {
  id: string;
  priority: number;
  productId: string | null;
  categoryId: string | null;
  storageRequirement: TemperatureZone | null;
  location: { id: string; zone: LocationZone; temperatureZone: TemperatureZone; archived: boolean };
}

export interface ProductFacts {
  id: string;
  categoryId: string | null;
  storageRequirement: TemperatureZone;
  /** The product's category and its parent categories (ADR-134); a rule on a parent covers them. */
  categoryLineage?: readonly string[];
}

export function ruleMatches(rule: RuleCandidate, p: ProductFacts): boolean {
  return (
    (rule.productId === null || rule.productId === p.id) &&
    (rule.categoryId === null ||
      rule.categoryId === p.categoryId ||
      (p.categoryLineage?.includes(rule.categoryId) ?? false)) &&
    (rule.storageRequirement === null || rule.storageRequirement === p.storageRequirement)
  );
}

/** A location the product may be put away into: right use, right temperature, active. */
export function locationFits(
  location: { zone: LocationZone; temperatureZone: TemperatureZone; archived: boolean },
  p: Pick<ProductFacts, "storageRequirement">,
): boolean {
  return (
    !location.archived &&
    PUTAWAY_TARGET_ZONES.includes(location.zone) &&
    location.temperatureZone === p.storageRequirement
  );
}

export type Suggestion =
  | { source: "RULE"; ruleId: string; locationId: string }
  | { source: "SAME_PRODUCT"; locationId: string }
  | { source: "NONE" };

/**
 * Where to put the product: the first matching rule by priority (lowest
 * first) whose location fits; else a fitting location already holding the
 * product; else no suggestion. Rules pointing at an unfit location are
 * skipped, never followed.
 */
export function suggestLocation(
  rules: readonly RuleCandidate[],
  product: ProductFacts,
  holding: ReadonlyArray<{
    id: string;
    zone: LocationZone;
    temperatureZone: TemperatureZone;
    archived: boolean;
  }> = [],
): Suggestion {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const r of ordered)
    if (ruleMatches(r, product) && locationFits(r.location, product))
      return { source: "RULE", ruleId: r.id, locationId: r.location.id };
  const same = holding.find((l) => locationFits(l, product));
  return same ? { source: "SAME_PRODUCT", locationId: same.id } : { source: "NONE" };
}

export interface InspectionFacts {
  /** Quarantined quantity of the line, base unit. */
  total: DecimalInput;
  accepted: DecimalInput;
  checksPassed: boolean;
  hasRejectionReason: boolean;
  hasNote: boolean;
}

export type InspectionProblem =
  "ACCEPTED_OUT_OF_RANGE" | "REJECTION_REASON_REQUIRED" | "INSPECTION_NOTE_REQUIRED";

/**
 * Split a quarantined quantity into accepted and rejected. Accepting goods
 * that failed a check needs a note saying why.
 */
export function inspectionOutcome(f: InspectionFacts):
  | {
      ok: true;
      accepted: Decimal;
      rejected: Decimal;
      decision: "ACCEPTED" | "REJECTED" | "PARTIAL";
    }
  | { ok: false; problem: InspectionProblem } {
  const total = new Decimal(f.total);
  const accepted = new Decimal(f.accepted);
  if (accepted.isNegative() || accepted.gt(total))
    return { ok: false, problem: "ACCEPTED_OUT_OF_RANGE" };
  const rejected = total.minus(accepted);
  if (rejected.gt(0) && !f.hasRejectionReason)
    return { ok: false, problem: "REJECTION_REASON_REQUIRED" };
  if (accepted.gt(0) && !f.checksPassed && !f.hasNote)
    return { ok: false, problem: "INSPECTION_NOTE_REQUIRED" };
  const decision = rejected.isZero() ? "ACCEPTED" : accepted.isZero() ? "REJECTED" : "PARTIAL";
  return { ok: true, accepted, rejected, decision };
}

// ─── Picking (ADR-102) ───

/** Stock a pick may come from: never quarantine or dispatch areas. */
export const PICK_SOURCE_ZONES: readonly (LocationZone | null)[] = [
  "PICKING",
  "STORAGE",
  "RECEIVING",
  null,
];

export interface PickCandidate {
  key: string;
  locationId: string | null;
  locationCode: string | null;
  zone: LocationZone | null;
  lotId: string | null;
  expiresOn: string | null;
  bestBeforeOn: string | null;
  firstReceivedAt: Date;
  recallHold: boolean;
  /** On hand minus what open pick lists already hold here. */
  available: Decimal;
}

const nullsLast = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

/**
 * Plan a pick: first-expiring stock first (expiry, best-before, oldest
 * receipt), then picking before storage before receiving areas, then by
 * location code. Expired, recalled, empty and non-source places are
 * skipped. What cannot be planned is the shortfall.
 */
export function allocatePick(
  candidates: readonly PickCandidate[],
  requested: DecimalInput,
  today: string,
): { picks: Array<{ candidate: PickCandidate; quantity: Decimal }>; shortfall: Decimal } {
  const rank = (z: LocationZone | null) => PICK_SOURCE_ZONES.indexOf(z);
  const usable = candidates.filter(
    (c) =>
      rank(c.zone) >= 0 &&
      !c.recallHold &&
      c.available.gt(0) &&
      !(c.expiresOn !== null && c.expiresOn < today),
  );
  usable.sort(
    (a, b) =>
      nullsLast(a.expiresOn, b.expiresOn) ||
      nullsLast(a.bestBeforeOn, b.bestBeforeOn) ||
      a.firstReceivedAt.getTime() - b.firstReceivedAt.getTime() ||
      rank(a.zone) - rank(b.zone) ||
      nullsLast(a.locationCode, b.locationCode),
  );
  let remaining = new Decimal(requested);
  const picks: Array<{ candidate: PickCandidate; quantity: Decimal }> = [];
  for (const c of usable) {
    if (remaining.lte(0)) break;
    const take = Decimal.min(c.available, remaining);
    picks.push({ candidate: c, quantity: take });
    remaining = remaining.minus(take);
  }
  return { picks, shortfall: Decimal.max(remaining, 0) };
}

/** Walk order for a pick sheet: by location code, stock without a location last. */
export function walkOrder<T extends { locationCode: string | null; sku: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) => nullsLast(a.locationCode, b.locationCode) || a.sku.localeCompare(b.sku),
  );
}
