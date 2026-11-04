import { Decimal } from "@/lib/decimal";

/**
 * Kitchen performance statistics (DECISIONS.md ADR-108). Pure. Times are in
 * seconds; percentiles interpolate linearly between ranks (as SQL
 * percentile_cont). A ticket is within target when it took less than its
 * target, as on the station screen (ADR-063), where reaching the target is late.
 */

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export interface TicketStats {
  tickets: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  meanSeconds: number | null;
  /** Share of tickets done within their target; null without targets or tickets. */
  withinTarget: Decimal | null;
}

export function ticketStats(
  tickets: ReadonlyArray<{ seconds: number; targetSeconds: number | null }>,
): TicketStats {
  const sorted = tickets.map((t) => t.seconds).sort((a, b) => a - b);
  const targeted = tickets.filter((t) => t.targetSeconds !== null);
  return {
    tickets: tickets.length,
    medianSeconds: percentile(sorted, 0.5),
    p90Seconds: percentile(sorted, 0.9),
    meanSeconds: sorted.length ? sorted.reduce((a, s) => a + s, 0) / sorted.length : null,
    withinTarget: targeted.length
      ? new Decimal(targeted.filter((t) => t.seconds < t.targetSeconds!).length).div(
          targeted.length,
        )
      : null,
  };
}
