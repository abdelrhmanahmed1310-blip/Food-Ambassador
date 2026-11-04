import { Decimal } from "@/lib/decimal";

/**
 * Customer segments, RFM and guest feedback (DECISIONS.md ADR-118). Pure.
 */

export interface CustomerStats {
  customerId: string;
  /** Paid orders and spend (gross less refunds) in the window. */
  orders: number;
  spend: Decimal;
  /** Last visit ever, business date. */
  lastVisit: string | null;
  branchIds: string[];
  marketingConsent: boolean;
  points: number;
}

/** Every condition is optional; all those given must hold. */
export interface SegmentRules {
  windowDays: number;
  visitedWithinDays?: number;
  notVisitedForDays?: number;
  minOrders?: number;
  maxOrders?: number;
  minSpend?: string;
  branchIds?: string[];
  consentOnly?: boolean;
  minPoints?: number;
}

const DAY = 86_400_000;
export const daysSince = (date: string, today: string) =>
  Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY);

export function matches(s: CustomerStats, r: SegmentRules, today: string): boolean {
  const since = s.lastVisit === null ? null : daysSince(s.lastVisit, today);
  if (r.visitedWithinDays !== undefined && (since === null || since > r.visitedWithinDays))
    return false;
  if (r.notVisitedForDays !== undefined && since !== null && since < r.notVisitedForDays)
    return false;
  if (r.minOrders !== undefined && s.orders < r.minOrders) return false;
  if (r.maxOrders !== undefined && s.orders > r.maxOrders) return false;
  if (r.minSpend !== undefined && s.spend.lt(r.minSpend)) return false;
  if (r.branchIds?.length && !s.branchIds.some((b) => r.branchIds!.includes(b))) return false;
  if (r.consentOnly && !s.marketingConsent) return false;
  if (r.minPoints !== undefined && s.points < r.minPoints) return false;
  return true;
}

/** 1–5 by rank (ties share the lower score), highest value = 5. */
function quintiles(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    const rank = sorted.indexOf(v); // first position of v
    return Math.min(5, Math.floor((rank / values.length) * 5) + 1);
  });
}

export const RFM_GROUPS = ["CHAMPIONS", "LOYAL", "NEW", "AT_RISK", "LOST", "OTHERS"] as const;
export type RfmGroup = (typeof RFM_GROUPS)[number];

/**
 * The usual RFM reading of customers who bought in the window: recency,
 * frequency and spend each scored 1–5 by quintile among them, then grouped
 * — champions (R ≥ 4, F ≥ 4), loyal (F ≥ 4), new (R ≥ 4, one order), at
 * risk (R ≤ 2, F ≥ 3), lost (R = 1, F ≤ 2), the rest others. A heuristic
 * to look at, not a rule.
 */
export function rfm(stats: ReadonlyArray<CustomerStats>, today: string) {
  const buyers = stats.filter((s) => s.orders > 0 && s.lastVisit !== null);
  const r = quintiles(buyers.map((s) => -daysSince(s.lastVisit!, today)));
  const f = quintiles(buyers.map((s) => s.orders));
  const m = quintiles(buyers.map((s) => s.spend.toNumber()));
  return buyers.map((s, i) => {
    const group: RfmGroup =
      r[i] >= 4 && f[i] >= 4
        ? "CHAMPIONS"
        : f[i] >= 4
          ? "LOYAL"
          : r[i] >= 4 && s.orders === 1
            ? "NEW"
            : r[i] <= 2 && f[i] >= 3
              ? "AT_RISK"
              : r[i] === 1 && f[i] <= 2
                ? "LOST"
                : "OTHERS";
    return { customerId: s.customerId, r: r[i], f: f[i], m: m[i], group };
  });
}

/** A feedback link stays open this many days after the order. */
export const FEEDBACK_DAYS = 14;
export const LOW_RATING = 2;

/** Ratings summary: count, average, share of 4–5, and how many of each. */
export function ratingSummary(ratings: ReadonlyArray<number>) {
  const count = ratings.length;
  const dist = [1, 2, 3, 4, 5].map((n) => ratings.filter((r) => r === n).length);
  return {
    count,
    average: count ? new Decimal(ratings.reduce((a, r) => a + r, 0)).div(count) : null,
    happyShare: count ? new Decimal(dist[3] + dist[4]).div(count) : null,
    distribution: dist,
  };
}
