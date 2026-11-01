import "server-only";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { codeSchema, optionalUuidSchema, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { prepStats, stationFor } from "./kitchen-rules";

/**
 * Kitchen display (DECISIONS.md ADR-063): stations per branch, routes from
 * menu categories or items to stations, tickets created when items reach
 * the kitchen (sent from a check, or a paid counter order), bumped when
 * ready; the ready status flows back to checks and orders.
 */

const at = (branchId: string) => ({ branchId, warehouseId: "" });

async function audit(
  tx: Tx,
  ctx: TenantContext,
  entityType: string,
  entityId: string,
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `${entityType}.${action}`,
    entityType,
    entityId,
    changes,
  });
}

// ─── Setup (pos.manage) ───

const stationSchema = z.object({
  branchId: uuidSchema,
  code: codeSchema,
  name: requiredText(80),
  targetMinutes: z.coerce
    .number()
    .int()
    .min(1, { error: "invalid" })
    .max(240, { error: "invalid" }),
  isDefault: z
    .union([z.literal("on"), z.literal(""), z.boolean()])
    .optional()
    .transform((v) => v === "on" || v === true),
});

export async function createStation(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "pos.manage");
  const parsed = stationSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { organizationId: ctx.organizationId, id: input.branchId },
        select: { id: true },
      });
      if (!branch) throw notFound("Branch");
      const s = await tx.kitchenStation.create({
        data: { organizationId: ctx.organizationId, ...input },
        select: { id: true },
      });
      await audit(tx, ctx, "kitchen_station", s.id, "created", input);
      return s;
    });
  } catch (error) {
    if (isUniqueViolation(error, "kitchen_stations_one_default"))
      throw businessRuleViolation(
        "STATION_DEFAULT_TAKEN",
        "This branch already has a default station",
        {
          field: "isDefault",
        },
      );
    if (isUniqueViolation(error))
      throw conflict("This code is already used", { reason: "codeTaken", field: "code" });
    throw error;
  }
}

const routeSchema = z
  .object({ categoryId: optionalUuidSchema, menuItemId: optionalUuidSchema })
  .refine((v) => Boolean(v.categoryId) !== Boolean(v.menuItemId), {
    error: "required",
    path: ["categoryId"],
  });

/** Send a category, or one item, to this station at its branch (replacing an earlier route). */
export async function setRoute(ctx: TenantContext, stationId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "pos.manage");
  const parsed = routeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const station = await tx.kitchenStation.findFirst({
      where: { organizationId: ctx.organizationId, id: stationId, archivedAt: null },
    });
    if (!station) throw notFound("Station");
    if (input.categoryId) {
      const c = await tx.menuCategory.findFirst({
        where: { organizationId: ctx.organizationId, id: input.categoryId },
        select: { id: true },
      });
      if (!c) throw notFound("Category");
    } else {
      const i = await tx.menuItem.findFirst({
        where: { organizationId: ctx.organizationId, id: input.menuItemId! },
        select: { id: true },
      });
      if (!i) throw notFound("Menu item");
    }
    const target = input.categoryId
      ? { categoryId: input.categoryId }
      : { menuItemId: input.menuItemId! };
    await tx.kitchenRoute.deleteMany({
      where: { organizationId: ctx.organizationId, branchId: station.branchId, ...target },
    });
    await tx.kitchenRoute.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: station.branchId,
        stationId: station.id,
        ...target,
      },
    });
    await audit(tx, ctx, "kitchen_station", station.id, "route_set", target);
  });
}

export async function removeRoute(ctx: TenantContext, routeId: string) {
  assertPermission(ctx.grants, "pos.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const r = await tx.kitchenRoute.findFirst({
      where: { organizationId: ctx.organizationId, id: routeId },
    });
    if (!r) throw notFound("Route");
    await tx.kitchenRoute.delete({ where: { id: r.id } });
    await audit(tx, ctx, "kitchen_station", r.stationId, "route_removed", {
      categoryId: r.categoryId,
      menuItemId: r.menuItemId,
    });
  });
}

/** Stations with their routes, and the menu to route (setup page). */
export async function kitchenSetup(ctx: TenantContext) {
  assertPermission(ctx.grants, "pos.manage");
  return withTenantTx(ctx.organizationId, async (tx) => ({
    branches: await tx.branch.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    stations: await tx.kitchenStation.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      include: {
        branch: { select: { code: true, name: true } },
        routes: {
          include: {
            category: { select: { name: true } },
            menuItem: { select: { code: true, name: true } },
          },
        },
      },
      orderBy: [{ branch: { code: "asc" } }, { sortOrder: "asc" }, { code: "asc" }],
    }),
    categories: await tx.menuCategory.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    items: await tx.menuItem.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
      take: 2000,
    }),
  }));
}

// ─── Tickets ───

export interface TicketLine {
  tabLineId?: string;
  orderLineId?: string;
  menuItemId: string;
  name: string;
  quantity: Decimal;
  options: string[];
  note?: string | null;
  seat?: number | null;
  course?: number | null;
}

/**
 * Route items that reached the kitchen to their stations: one ticket per
 * station. Items no station takes get no ticket. Called inside the send /
 * order transaction; access was checked by the caller.
 */
export async function createTicketsInTx(
  tx: Tx,
  ctx: TenantContext,
  source: {
    branchId: string;
    tabId?: string;
    orderId?: string;
    label: string;
    guests?: number | null;
  },
  lines: readonly TicketLine[],
) {
  if (lines.length === 0) return 0;
  const org = ctx.organizationId;
  const stations = await tx.kitchenStation.findMany({
    where: { organizationId: org, branchId: source.branchId, archivedAt: null },
    select: { id: true, isDefault: true },
  });
  if (stations.length === 0) return 0;
  const routes = await tx.kitchenRoute.findMany({
    where: { organizationId: org, branchId: source.branchId, station: { archivedAt: null } },
    select: { stationId: true, categoryId: true, menuItemId: true },
  });
  const items = await tx.menuItem.findMany({
    where: { organizationId: org, id: { in: [...new Set(lines.map((l) => l.menuItemId))] } },
    select: { id: true, categoryId: true },
  });
  const categoryOf = new Map(items.map((i) => [i.id, i.categoryId]));
  const fallback = stations.find((s) => s.isDefault)?.id ?? null;
  const byStation = new Map<string, TicketLine[]>();
  for (const l of lines) {
    const station = stationFor(
      { id: l.menuItemId, categoryId: categoryOf.get(l.menuItemId) ?? "" },
      routes,
      fallback,
    );
    if (station) byStation.set(station, [...(byStation.get(station) ?? []), l]);
  }
  for (const [stationId, list] of byStation) {
    const ticket = await tx.kitchenTicket.create({
      data: {
        organizationId: org,
        branchId: source.branchId,
        stationId,
        tabId: source.tabId ?? null,
        orderId: source.orderId ?? null,
        label: source.label.slice(0, 80),
        guests: source.guests ?? null,
      },
      select: { id: true },
    });
    await tx.kitchenTicketItem.createMany({
      data: list.map((l) => ({
        organizationId: org,
        ticketId: ticket.id,
        tabLineId: l.tabLineId ?? null,
        orderLineId: l.orderLineId ?? null,
        name: l.name,
        quantity: l.quantity.toFixed(),
        options: l.options,
        note: l.note ?? null,
        seat: l.seat ?? null,
        course: l.course ?? null,
      })),
    });
  }
  return byStation.size;
}

/** Strike items through on their tickets when they are voided after reaching the kitchen. */
export async function markVoidedInTx(
  tx: Tx,
  ctx: TenantContext,
  ids: { tabLineIds?: string[]; orderLineIds?: string[] },
) {
  const or = [
    ...(ids.tabLineIds?.length ? [{ tabLineId: { in: ids.tabLineIds } }] : []),
    ...(ids.orderLineIds?.length ? [{ orderLineId: { in: ids.orderLineIds } }] : []),
  ];
  if (or.length === 0) return;
  await tx.kitchenTicketItem.updateMany({
    where: { organizationId: ctx.organizationId, voidedAt: null, OR: or },
    data: { voidedAt: new Date() },
  });
}

/** Kitchen status of check lines: preparing until every ticket holding it is bumped. */
export async function lineStatusesInTx(tx: Tx, ctx: TenantContext, tabId: string) {
  const items = await tx.kitchenTicketItem.findMany({
    where: { organizationId: ctx.organizationId, ticket: { tabId }, tabLineId: { not: null } },
    select: { tabLineId: true, ticket: { select: { status: true } } },
  });
  const status = new Map<string, "PREPARING" | "READY">();
  for (const i of items) {
    const now = i.ticket.status === "DONE" ? "READY" : "PREPARING";
    if (status.get(i.tabLineId!) !== "PREPARING") status.set(i.tabLineId!, now);
  }
  return status;
}

/** Kitchen status of orders (null = nothing went to a kitchen). */
export async function orderStatusesInTx(tx: Tx, ctx: TenantContext, orderIds: string[]) {
  const tickets = await tx.kitchenTicket.findMany({
    where: { organizationId: ctx.organizationId, orderId: { in: orderIds } },
    select: { orderId: true, status: true },
  });
  const status = new Map<string, "PREPARING" | "READY">();
  for (const t of tickets) {
    const now = t.status === "DONE" ? "READY" : "PREPARING";
    if (status.get(t.orderId!) !== "PREPARING") status.set(t.orderId!, now);
  }
  return status;
}

async function loadStation(tx: Tx, ctx: TenantContext, stationId: string) {
  const s = await tx.kitchenStation.findFirst({
    where: { organizationId: ctx.organizationId, id: stationId },
    include: { branch: { select: { code: true, name: true, timeZone: true } } },
  });
  if (!s || !hasPermission(ctx.grants, "pos.kitchen", at(s.branchId))) throw notFound("Station");
  return s;
}

/** Stations the user may work (the kitchen screens list). */
export async function listStations(ctx: TenantContext) {
  const scope = accessibleScope(ctx.grants, "pos.kitchen");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const stations = await tx.kitchenStation.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(scope.all ? {} : { branchId: { in: scope.branchIds } }),
      },
      include: {
        branch: { select: { code: true, name: true } },
        _count: { select: { tickets: { where: { status: "OPEN" } } } },
      },
      orderBy: [{ branch: { code: "asc" } }, { sortOrder: "asc" }, { code: "asc" }],
    });
    return stations;
  });
}

/** A station's screen: open tickets oldest first, and the last bumped one (to recall). */
export async function stationBoard(ctx: TenantContext, stationId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const station = await loadStation(tx, ctx, stationId);
    const include = {
      items: { orderBy: [{ course: "asc" as const }, { seat: "asc" as const }] },
    };
    const open = await tx.kitchenTicket.findMany({
      where: { organizationId: ctx.organizationId, stationId, status: "OPEN" },
      include,
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    const lastDone = await tx.kitchenTicket.findFirst({
      where: { organizationId: ctx.organizationId, stationId, status: "DONE" },
      select: { id: true, label: true, bumpedAt: true },
      orderBy: { bumpedAt: "desc" },
    });
    return { station, tickets: open, lastDone };
  });
}

/** The ticket is ready: off the screen; its items show as ready to the waiter and cashier. */
export async function bumpTicket(ctx: TenantContext, ticketId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await tx.kitchenTicket.findFirst({
      where: { organizationId: ctx.organizationId, id: ticketId },
    });
    if (!t) throw notFound("Ticket");
    await loadStation(tx, ctx, t.stationId);
    if (t.status !== "OPEN") return; // bumped twice (two taps): nothing to do
    await tx.kitchenTicket.update({
      where: { id: t.id },
      data: { status: "DONE", bumpedAt: new Date(), bumpedByUserId: ctx.userId },
    });
    await audit(tx, ctx, "kitchen_ticket", t.id, "bumped", { label: t.label });
  });
}

/** Bring a bumped ticket back to the screen (bumped by mistake). */
export async function recallTicket(ctx: TenantContext, ticketId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await tx.kitchenTicket.findFirst({
      where: { organizationId: ctx.organizationId, id: ticketId },
    });
    if (!t) throw notFound("Ticket");
    await loadStation(tx, ctx, t.stationId);
    if (t.status !== "DONE")
      throw businessRuleViolation("TICKET_NOT_BUMPED", "This ticket is still on the screen");
    await tx.kitchenTicket.update({
      where: { id: t.id },
      data: { status: "OPEN", bumpedAt: null, bumpedByUserId: null },
    });
    await audit(tx, ctx, "kitchen_ticket", t.id, "recalled", { label: t.label });
  });
}

/** Preparation times (sent to bumped) of a station's tickets over a period. */
export async function prepTimes(
  ctx: TenantContext,
  stationId: string,
  period: { from: Date; to: Date },
) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const station = await loadStation(tx, ctx, stationId);
    const done = await tx.kitchenTicket.findMany({
      where: {
        organizationId: ctx.organizationId,
        stationId,
        status: "DONE",
        createdAt: { gte: period.from, lt: period.to },
      },
      select: { createdAt: true, bumpedAt: true },
    });
    const minutes = done.map((t) => (t.bumpedAt!.getTime() - t.createdAt.getTime()) / 60_000);
    const stats = prepStats(minutes);
    return {
      ...stats,
      late: minutes.filter((m) => m >= station.targetMinutes).length,
      targetMinutes: station.targetMinutes,
    };
  });
}
