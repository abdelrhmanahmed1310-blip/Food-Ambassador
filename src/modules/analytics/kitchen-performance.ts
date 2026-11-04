import "server-only";
import { z } from "zod";
import { toCsv } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { accessibleScope, holdsAnyGrant } from "@/modules/access/authorize";
import { addDays, businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { forbidden, validationFailed } from "@/server/errors";
import { ticketStats } from "./kitchen-rules";

/**
 * Kitchen display performance (DECISIONS.md ADR-108), from kitchen tickets
 * only (ADR-063): a ticket's time is from when it reached the station to
 * when it was bumped. Tickets count on the day and hour they were sent, in
 * the branch's time zone. Targets are each station's current target
 * minutes. Needs `sales.view` at the branches shown.
 */

const periodSchema = z
  .object({
    from: z.string().refine(isCalendarDate, { error: "invalidDate" }),
    to: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  })
  .refine((p) => p.from <= p.to, { error: "invalidPeriod", path: ["to"] });

export const canSeeKitchenPerformance = (ctx: TenantContext) =>
  holdsAnyGrant(ctx.grants, "sales.view");

const MAX_TICKETS = 50_000;

function localHour(timeZone: string, at: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(at),
  );
}

export async function kitchenPerformance(
  ctx: TenantContext,
  rawPeriod: unknown,
  filters: { branchId?: string } = {},
) {
  if (!canSeeKitchenPerformance(ctx)) throw forbidden();
  const p = periodSchema.safeParse(rawPeriod);
  if (!p.success) throw validationFailed(p.error);
  const period = p.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const scope = accessibleScope(ctx.grants, "sales.view");
    const branches = await tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(filters.branchId ? { id: filters.branchId } : {}),
        ...(scope.all
          ? {}
          : {
              OR: [
                { id: { in: scope.branchIds } },
                { warehouses: { some: { id: { in: scope.warehouseIds } } } },
              ],
            }),
      },
      select: { id: true, code: true, name: true, timeZone: true },
      orderBy: { code: "asc" },
    });
    const zoneOf = new Map(branches.map((b) => [b.id, b.timeZone ?? ctx.timeZone]));
    const stations = await tx.kitchenStation.findMany({
      where: { organizationId: ctx.organizationId, branchId: { in: branches.map((b) => b.id) } },
      select: {
        id: true,
        code: true,
        name: true,
        targetMinutes: true,
        branchId: true,
        archivedAt: true,
      },
      orderBy: [{ branchId: "asc" }, { sortOrder: "asc" }, { code: "asc" }],
    });
    const stationOf = new Map(stations.map((s) => [s.id, s]));
    // A day either side covers every time zone; the exact local day is checked below.
    const raw = stations.length
      ? await tx.kitchenTicket.findMany({
          where: {
            organizationId: ctx.organizationId,
            stationId: { in: stations.map((s) => s.id) },
            createdAt: {
              gte: new Date(`${addDays(period.from, -1)}T00:00:00Z`),
              lt: new Date(`${addDays(period.to, 2)}T00:00:00Z`),
            },
          },
          select: {
            id: true,
            stationId: true,
            branchId: true,
            status: true,
            createdAt: true,
            bumpedAt: true,
            items: { select: { voidedAt: true } },
          },
          orderBy: { createdAt: "asc" },
          take: MAX_TICKETS,
        })
      : [];
    const tickets = raw
      .map((t) => {
        const zone = zoneOf.get(t.branchId) ?? ctx.timeZone;
        return { ...t, day: businessDate(zone, t.createdAt), hour: localHour(zone, t.createdAt) };
      })
      .filter((t) => t.day >= period.from && t.day <= period.to);
    const done = tickets
      .filter((t) => t.bumpedAt)
      .map((t) => ({
        ...t,
        seconds: Math.max(0, (t.bumpedAt!.getTime() - t.createdAt.getTime()) / 1000),
        targetSeconds: (stationOf.get(t.stationId)?.targetMinutes ?? 0) * 60 || null,
      }));
    const items = (list: typeof tickets) => ({
      items: list.reduce((a, t) => a + t.items.filter((i) => !i.voidedAt).length, 0),
      voidedItems: list.reduce((a, t) => a + t.items.filter((i) => i.voidedAt).length, 0),
    });

    // Open right now, whatever the period: still on the screens, and late ones.
    const openNow = stations.length
      ? await tx.kitchenTicket.findMany({
          where: {
            organizationId: ctx.organizationId,
            stationId: { in: stations.map((s) => s.id) },
            status: "OPEN",
          },
          select: { stationId: true, createdAt: true },
        })
      : [];
    const now = Date.now();
    const lateNow = (stationId: string) =>
      openNow.filter(
        (o) =>
          o.stationId === stationId &&
          now - o.createdAt.getTime() >
            (stationOf.get(stationId)?.targetMinutes ?? Infinity) * 60_000,
      ).length;

    const byStation = stations
      .map((s) => {
        const sent = tickets.filter((t) => t.stationId === s.id);
        return {
          station: s,
          branch: branches.find((b) => b.id === s.branchId)!,
          sent: sent.length,
          ...ticketStats(done.filter((t) => t.stationId === s.id)),
          stillOpen: sent.filter((t) => !t.bumpedAt).length,
          openNow: openNow.filter((o) => o.stationId === s.id).length,
          lateNow: lateNow(s.id),
          ...items(sent),
        };
      })
      .filter((s) => s.sent > 0 || s.openNow > 0 || !s.station.archivedAt);
    const hours = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      sent: tickets.filter((t) => t.hour === h).length,
      ...ticketStats(done.filter((t) => t.hour === h)),
    }));
    const days = [...new Set(tickets.map((t) => t.day))].sort().map((d) => ({
      day: d,
      sent: tickets.filter((t) => t.day === d).length,
      ...ticketStats(done.filter((t) => t.day === d)),
    }));
    return {
      period,
      truncated: raw.length >= MAX_TICKETS,
      total: {
        sent: tickets.length,
        ...ticketStats(done),
        stillOpen: tickets.filter((t) => !t.bumpedAt).length,
        openNow: openNow.length,
        lateNow: stations.reduce((a, s) => a + lateNow(s.id), 0),
        ...items(tickets),
      },
      stations: byStation,
      hours,
      days,
      branches,
    };
  });
}

export async function exportKitchenCsv(
  ctx: TenantContext,
  rawPeriod: unknown,
  filters: { branchId?: string } = {},
) {
  const r = await kitchenPerformance(ctx, rawPeriod, filters);
  const min = (s: number | null) => (s === null ? "" : (s / 60).toFixed(1));
  return toCsv(
    [
      "branch",
      "station",
      "target (min)",
      "tickets sent",
      "median (min)",
      "90th percentile (min)",
      "average (min)",
      "within target %",
      "not bumped",
      "items",
      "voided items",
    ],
    r.stations.map((s) => [
      s.branch.code,
      s.station.code,
      s.station.targetMinutes,
      s.sent,
      min(s.medianSeconds),
      min(s.p90Seconds),
      min(s.meanSeconds),
      s.withinTarget === null ? "" : s.withinTarget.times(100).toFixed(1),
      s.stillOpen,
      s.items,
      s.voidedItems,
    ]),
  );
}
