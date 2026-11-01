/** Kitchen display rules (DECISIONS.md ADR-063). Pure; shared by the server and the screens. */

export interface KitchenRoute {
  stationId: string;
  categoryId: string | null;
  menuItemId: string | null;
}

/**
 * The station an item goes to: its own route, else its category's, else the
 * branch's default station; null = no kitchen ticket (e.g. drinks served
 * from the bar without a screen).
 */
export function stationFor(
  item: { id: string; categoryId: string },
  routes: readonly KitchenRoute[],
  defaultStationId: string | null,
): string | null {
  return (
    routes.find((r) => r.menuItemId === item.id)?.stationId ??
    routes.find((r) => r.categoryId === item.categoryId)?.stationId ??
    defaultStationId
  );
}

export type Urgency = "ok" | "warning" | "late";

/** On time, close to the target (from 75 %), or late (at or past the target). */
export function ticketUrgency(elapsedMs: number, targetMinutes: number): Urgency {
  const target = targetMinutes * 60_000;
  if (elapsedMs >= target) return "late";
  if (elapsedMs >= target * 0.75) return "warning";
  return "ok";
}

/** Count, average and 90th percentile (nearest rank) of preparation times in minutes. */
export function prepStats(minutes: readonly number[]) {
  if (minutes.length === 0) return { count: 0, average: null, p90: null };
  const sorted = [...minutes].sort((a, b) => a - b);
  const average = sorted.reduce((a, m) => a + m, 0) / sorted.length;
  const p90 = sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)];
  return {
    count: sorted.length,
    average: Math.round(average * 10) / 10,
    p90: Math.round(p90 * 10) / 10,
  };
}
