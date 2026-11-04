/**
 * The restaurant's own delivery riders (DECISIONS.md ADR-117). Pure.
 */

/** Contact details are erased this many days after a delivery ends. */
export const CONTACT_RETENTION_DAYS = 30;

export const ACTIVE_STATUSES = ["WAITING", "ASSIGNED", "OUT"] as const;

export const minutesBetween = (from: Date | null, to: Date | null) =>
  from && to ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000)) : null;

/** A median of whole minutes; nothing for an empty list. */
export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export interface FinishedDelivery {
  riderUserId: string | null;
  status: string;
  createdAt: Date;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
}

/** Per rider: delivered, failed, and median minutes on the road and from order to door. */
export function riderStats(rows: ReadonlyArray<FinishedDelivery>) {
  const by = new Map<string, FinishedDelivery[]>();
  for (const r of rows)
    if (r.riderUserId) by.set(r.riderUserId, [...(by.get(r.riderUserId) ?? []), r]);
  return [...by].map(([riderUserId, list]) => {
    const done = list.filter((r) => r.status === "DELIVERED");
    return {
      riderUserId,
      delivered: done.length,
      failed: list.filter((r) => r.status === "FAILED").length,
      medianRoadMinutes: median(
        done.flatMap((r) => (r.pickedUpAt ? [minutesBetween(r.pickedUpAt, r.deliveredAt)!] : [])),
      ),
      medianTotalMinutes: median(done.map((r) => minutesBetween(r.createdAt, r.deliveredAt)!)),
    };
  });
}

/** A map search link for the address (no map service is called by the system). */
export const mapLink = (address: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
