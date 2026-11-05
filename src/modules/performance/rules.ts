/**
 * Performance rules (DECISIONS.md ADR-126). Pure.
 */

/** Ratings run from 1 to 5. */
export const RATINGS = [1, 2, 3, 4, 5] as const;
export type Rating = (typeof RATINGS)[number];

export const GOAL_STATUSES = [
  "OPEN",
  "ACHIEVED",
  "PARTLY_ACHIEVED",
  "MISSED",
  "CANCELLED",
] as const;

export type ReviewStatus =
  "NOT_STARTED" | "SELF_DONE" | "MANAGER_DONE" | "ACKNOWLEDGED" | "FINALIZED" | "SKIPPED";

export type ReviewStep = "SELF" | "MANAGER" | "ACKNOWLEDGE" | "FINALIZE" | "SKIP";

/** Which steps a review in this status still allows. */
export function allowedSteps(status: ReviewStatus): ReviewStep[] {
  switch (status) {
    case "NOT_STARTED":
      return ["SELF", "MANAGER", "SKIP"];
    case "SELF_DONE":
      return ["MANAGER", "SKIP"];
    case "MANAGER_DONE":
      return ["ACKNOWLEDGE", "FINALIZE", "SKIP"];
    case "ACKNOWLEDGED":
      return ["FINALIZE", "SKIP"];
    case "FINALIZED":
    case "SKIPPED":
      return [];
  }
}

/** Goals of one employee in one cycle may weigh at most 100 % together (cancelled ones aside). */
export function weightsWithin(
  goals: ReadonlyArray<{ weight: number; status: string }>,
  extra = 0,
): boolean {
  return (
    goals.filter((g) => g.status !== "CANCELLED").reduce((a, g) => a + g.weight, 0) + extra <= 100
  );
}

/**
 * The goals' score: ratings weighted by each goal's weight; when no goal
 * carries weight, a plain average. Null without rated goals. Kept to two
 * decimals.
 */
export function goalScore(
  ratings: ReadonlyArray<{ rating: number | null; weight: number }>,
): number | null {
  const rated = ratings.filter((r): r is { rating: number; weight: number } => r.rating !== null);
  if (rated.length === 0) return null;
  const totalWeight = rated.reduce((a, r) => a + r.weight, 0);
  const raw =
    totalWeight > 0
      ? rated.reduce((a, r) => a + r.rating * r.weight, 0) / totalWeight
      : rated.reduce((a, r) => a + r.rating, 0) / rated.length;
  return Math.round(raw * 100) / 100;
}

/** How many reviews ended at each rating (final rating, else the manager's). */
export function distribution(
  reviews: ReadonlyArray<{ finalRating: number | null; managerRating: number | null }>,
): Record<Rating, number> {
  const out = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<Rating, number>;
  for (const r of reviews) {
    const v = r.finalRating ?? r.managerRating;
    if (v && v >= 1 && v <= 5) out[v as Rating]++;
  }
  return out;
}
