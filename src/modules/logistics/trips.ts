import "server-only";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { codeSchema, optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import {
  allStopsResolved,
  distanceKm,
  isExcursion,
  isValidSignature,
  normalizeSignature,
  VEHICLE_TYPES,
} from "./rules";

/**
 * The organization's own fleet (DECISIONS.md ADR-116): vehicles, trips from
 * a warehouse with ordered stops for posted B2B deliveries and transfers in
 * transit, proof of delivery per stop and cold-chain readings. Viewing needs
 * `logistics.view`, planning `logistics.manage`, recording on the road
 * `logistics.deliver` — on the driver's own trips, or any trip for those
 * who also plan — all at the trip's warehouse.
 */

const dec = (v: { toString(): string } | null) => (v === null ? null : new Decimal(v.toString()));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const optionalTemp = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .pipe(decimalString({ maxScale: 1, min: "-60", max: "60", allowNegative: true }).optional());
const optionalKm = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .refine((v) => v === undefined || /^\d{1,7}$/.test(v), { error: "invalidNumber" })
  .transform((v) => (v === undefined ? undefined : Number(v)));

const vehicleSchema = z
  .object({
    code: codeSchema,
    plateNumber: requiredText(20),
    type: z.enum(VEHICLE_TYPES, { error: "invalidOption" }),
    warehouseId: uuidSchema,
    refrigerated: z
      .union([z.boolean(), z.enum(["on", "true", "false"])])
      .optional()
      .transform((v) => v === true || v === "on" || v === "true"),
    minTemperatureC: optionalTemp,
    maxTemperatureC: optionalTemp,
    capacityKg: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined))
      .pipe(decimalString({ maxScale: 1, min: "0" }).optional()),
  })
  .refine(
    (v) => !v.refrigerated || (v.minTemperatureC !== undefined && v.maxTemperatureC !== undefined),
    {
      error: "refrigeratedNeedsRange",
      path: ["minTemperatureC"],
    },
  )
  .refine(
    (v) =>
      !v.minTemperatureC ||
      !v.maxTemperatureC ||
      new Decimal(v.minTemperatureC).lte(v.maxTemperatureC),
    {
      error: "rangeReversed",
      path: ["maxTemperatureC"],
    },
  );

const tripSchema = z.object({
  warehouseId: uuidSchema,
  vehicleId: uuidSchema,
  driverUserId: uuidSchema,
  plannedOn: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  note: optionalText(500),
});

const stopSchema = z.object({
  kind: z.enum(["CUSTOMER_DELIVERY", "TRANSFER"], { error: "invalidOption" }),
  consignmentId: uuidSchema,
});

const podSchema = z.object({
  recipientName: requiredText(120),
  handoverTemperatureC: optionalTemp,
  signature: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .refine((v) => v === undefined || isValidSignature(v), { error: "invalidSignature" }),
  note: optionalText(500),
});

export const canSeeLogistics = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "logistics.view");
export const canPlanTrips = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "logistics.manage");

const at = (w: { id: string; branchId: string }) => ({ warehouseId: w.id, branchId: w.branchId });

async function audit(
  tx: Tx,
  ctx: TenantContext,
  entityType: string,
  id: string,
  action: string,
  changes: Record<string, unknown>,
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `${entityType}.${action}`,
    entityType,
    entityId: id,
    changes,
  });
}

async function loadWarehouse(
  tx: Tx,
  ctx: TenantContext,
  warehouseId: string,
  permission: "logistics.view" | "logistics.manage",
) {
  const w = await tx.warehouse.findFirst({
    where: { organizationId: ctx.organizationId, id: warehouseId, archivedAt: null },
    select: { id: true, code: true, name: true, branchId: true },
  });
  if (!w || !hasPermission(ctx.grants, "logistics.view", at(w))) throw notFound("Warehouse");
  if (!hasPermission(ctx.grants, permission, at(w))) throw forbidden();
  return w;
}

// ─── Vehicles ───

export async function createVehicle(ctx: TenantContext, rawInput: unknown) {
  const parsed = vehicleSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const w = await loadWarehouse(tx, ctx, v.warehouseId, "logistics.manage");
      const created = await tx.vehicle.create({
        data: {
          organizationId: ctx.organizationId,
          code: v.code,
          plateNumber: v.plateNumber,
          type: v.type,
          warehouseId: w.id,
          refrigerated: v.refrigerated,
          minTemperatureC: v.refrigerated ? v.minTemperatureC! : null,
          maxTemperatureC: v.refrigerated ? v.maxTemperatureC! : null,
          capacityKg: v.capacityKg ?? null,
        },
        select: { id: true, code: true },
      });
      await audit(tx, ctx, "vehicle", created.id, "created", v);
      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("Code already used", { reason: "codeTaken", field: "code" });
    throw error;
  }
}

export async function setVehicleArchived(ctx: TenantContext, vehicleId: string, archived: boolean) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    if (!isUuid(vehicleId)) throw notFound("Vehicle");
    const v = await tx.vehicle.findFirst({
      where: { organizationId: ctx.organizationId, id: vehicleId },
      select: { id: true, warehouse: { select: { id: true, branchId: true } } },
    });
    if (!v || !hasPermission(ctx.grants, "logistics.manage", at(v.warehouse)))
      throw notFound("Vehicle");
    await tx.vehicle.update({
      where: { id: v.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await audit(tx, ctx, "vehicle", v.id, archived ? "archived" : "restored", {});
  });
}

function warehouseScope(ctx: TenantContext) {
  const s = accessibleScope(ctx.grants, "logistics.view");
  return s.all ? {} : { OR: [{ id: { in: s.warehouseIds } }, { branchId: { in: s.branchIds } }] };
}

export async function listVehicles(ctx: TenantContext) {
  if (!canSeeLogistics(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.vehicle.findMany({
      where: { organizationId: ctx.organizationId, warehouse: warehouseScope(ctx) },
      include: { warehouse: { select: { id: true, code: true, name: true, branchId: true } } },
      orderBy: { code: "asc" },
    }),
  );
}

/** Members who may drive from a warehouse: an active role with `logistics.deliver` covering it. */
async function driversFor(tx: Tx, ctx: TenantContext, w: { id: string; branchId: string }) {
  const rows = await tx.organizationMembership.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: "ACTIVE",
      user: { status: "ACTIVE" },
      roles: {
        some: {
          role: { permissions: { some: { permission: "logistics.deliver" } } },
          OR: [
            { scopeType: "ORGANIZATION" },
            { scopeType: "BRANCH", branchId: w.branchId },
            { scopeType: "WAREHOUSE", warehouseId: w.id },
          ],
        },
      },
    },
    select: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return rows.map((r) => r.user);
}

/** Warehouses the user plans trips from, with their vehicles and drivers. */
export async function tripFormOptions(ctx: TenantContext) {
  if (!canPlanTrips(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const warehouses = (
      await tx.warehouse.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, code: true, name: true, branchId: true },
        orderBy: { code: "asc" },
      })
    ).filter((w) => hasPermission(ctx.grants, "logistics.manage", at(w)));
    const vehicles = await tx.vehicle.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        warehouseId: { in: warehouses.map((w) => w.id) },
      },
      select: { id: true, code: true, plateNumber: true, warehouseId: true, refrigerated: true },
      orderBy: { code: "asc" },
    });
    const drivers = new Map<string, Awaited<ReturnType<typeof driversFor>>>();
    for (const w of warehouses) drivers.set(w.id, await driversFor(tx, ctx, w));
    return { warehouses, vehicles, drivers: Object.fromEntries(drivers) };
  });
}

// ─── Trips ───

export async function createTrip(ctx: TenantContext, rawInput: unknown) {
  const parsed = tripSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const w = await loadWarehouse(tx, ctx, input.warehouseId, "logistics.manage");
    const vehicle = await tx.vehicle.findFirst({
      where: { organizationId: ctx.organizationId, id: input.vehicleId, archivedAt: null },
      select: { id: true, warehouseId: true },
    });
    if (!vehicle) throw notFound("Vehicle");
    if (vehicle.warehouseId !== w.id)
      throw businessRuleViolation(
        "VEHICLE_OTHER_WAREHOUSE",
        "The vehicle is based at another warehouse",
        { field: "vehicleId" },
      );
    if (!(await driversFor(tx, ctx, w)).some((d) => d.id === input.driverUserId))
      throw businessRuleViolation(
        "DRIVER_NOT_ALLOWED",
        "This person may not drive from this warehouse",
        {
          field: "driverUserId",
        },
      );
    const number = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      "TRP",
      Number(input.plannedOn.slice(0, 4)),
    );
    const trip = await tx.trip.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        warehouseId: w.id,
        vehicleId: vehicle.id,
        driverUserId: input.driverUserId,
        plannedOn: new Date(`${input.plannedOn}T00:00:00Z`),
        note: input.note ?? null,
        createdByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    await audit(tx, ctx, "trip", trip.id, "created", { ...input, number });
    return trip;
  });
}

async function loadTrip(tx: Tx, ctx: TenantContext, tripId: string) {
  if (!isUuid(tripId)) throw notFound("Trip");
  const t = await tx.trip.findFirst({
    where: { organizationId: ctx.organizationId, id: tripId },
    include: {
      warehouse: { select: { id: true, branchId: true } },
      vehicle: { select: { refrigerated: true, minTemperatureC: true, maxTemperatureC: true } },
      stops: { select: { id: true, status: true, sequence: true } },
    },
  });
  if (!t || !hasPermission(ctx.grants, "logistics.view", at(t.warehouse))) throw notFound("Trip");
  const plan = hasPermission(ctx.grants, "logistics.manage", at(t.warehouse));
  const deliver =
    hasPermission(ctx.grants, "logistics.deliver", at(t.warehouse)) &&
    (t.driverUserId === ctx.userId || plan);
  return { ...t, plan, deliver };
}

function assertTripStatus(t: { status: string }, allowed: string[], rule: string) {
  if (!allowed.includes(t.status))
    throw businessRuleViolation(rule, `Not possible while the trip is ${t.status}`, {
      status: t.status,
    });
}

/** A posted delivery or a transfer in transit from the trip's warehouse, not on another open stop. */
export async function addStop(ctx: TenantContext, tripId: string, rawInput: unknown) {
  const parsed = stopSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { kind, consignmentId } = parsed.data;
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const t = await loadTrip(tx, ctx, tripId);
      if (!t.plan) throw forbidden();
      assertTripStatus(t, ["PLANNED"], "TRIP_NOT_PLANNED");
      if (kind === "CUSTOMER_DELIVERY") {
        const d = await tx.customerDelivery.findFirst({
          where: { organizationId: ctx.organizationId, id: consignmentId },
          select: { status: true, order: { select: { warehouseId: true } } },
        });
        if (!d) throw notFound("Delivery");
        if (d.status !== "POSTED" || d.order.warehouseId !== t.warehouseId)
          throw businessRuleViolation(
            "CONSIGNMENT_NOT_AVAILABLE",
            "Not a posted delivery from this warehouse",
            {
              field: "consignmentId",
            },
          );
      } else {
        const sh = await tx.stockShipment.findFirst({
          where: { organizationId: ctx.organizationId, id: consignmentId },
          select: { status: true, fromWarehouseId: true },
        });
        if (!sh) throw notFound("Transfer");
        if (sh.status !== "IN_TRANSIT" || sh.fromWarehouseId !== t.warehouseId)
          throw businessRuleViolation(
            "CONSIGNMENT_NOT_AVAILABLE",
            "Not a transfer in transit from this warehouse",
            {
              field: "consignmentId",
            },
          );
      }
      const sequence = Math.max(0, ...t.stops.map((s) => s.sequence)) + 1;
      await tx.tripStop.create({
        data: {
          organizationId: ctx.organizationId,
          tripId: t.id,
          sequence,
          kind,
          customerDeliveryId: kind === "CUSTOMER_DELIVERY" ? consignmentId : null,
          stockShipmentId: kind === "TRANSFER" ? consignmentId : null,
        },
      });
      await audit(tx, ctx, "trip", t.id, "stop_added", { kind, consignmentId, sequence });
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("Already on a trip", { reason: "consignmentOnTrip", field: "consignmentId" });
    throw error;
  }
}

export async function removeStop(ctx: TenantContext, tripId: string, stopId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await loadTrip(tx, ctx, tripId);
    if (!t.plan) throw forbidden();
    assertTripStatus(t, ["PLANNED"], "TRIP_NOT_PLANNED");
    if (!isUuid(stopId)) throw notFound("Stop");
    const gone = await tx.tripStop.deleteMany({
      where: { organizationId: ctx.organizationId, tripId: t.id, id: stopId },
    });
    if (!gone.count) throw notFound("Stop");
    await audit(tx, ctx, "trip", t.id, "stop_removed", { stopId });
  });
}

export async function startTrip(ctx: TenantContext, tripId: string, rawInput: unknown = {}) {
  const parsed = z.object({ startOdometerKm: optionalKm }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await loadTrip(tx, ctx, tripId);
    if (!t.deliver) throw forbidden();
    assertTripStatus(t, ["PLANNED"], "TRIP_NOT_PLANNED");
    if (t.stops.length === 0)
      throw businessRuleViolation("TRIP_HAS_NO_STOPS", "Add the stops first");
    const moved = await tx.trip.updateMany({
      where: { organizationId: ctx.organizationId, id: t.id, status: "PLANNED" },
      data: {
        status: "IN_PROGRESS",
        startedAt: new Date(),
        startOdometerKm: parsed.data.startOdometerKm ?? null,
      },
    });
    if (!moved.count) throw conflict("The trip changed meanwhile");
    await audit(tx, ctx, "trip", t.id, "started", parsed.data);
  });
}

async function readingInTx(
  tx: Tx,
  ctx: TenantContext,
  t: Awaited<ReturnType<typeof loadTrip>>,
  temperatureC: string,
  note: string | null,
) {
  const excursion =
    t.vehicle.refrigerated &&
    isExcursion(temperatureC, {
      min: dec(t.vehicle.minTemperatureC),
      max: dec(t.vehicle.maxTemperatureC),
    });
  await tx.temperatureReading.create({
    data: {
      organizationId: ctx.organizationId,
      tripId: t.id,
      temperatureC,
      readAt: new Date(),
      excursion,
      note,
      recordedByUserId: ctx.userId,
    },
  });
  return excursion;
}

/** A load-compartment reading on the road; outside the vehicle's range is an excursion. */
export async function recordReading(ctx: TenantContext, tripId: string, rawInput: unknown) {
  const parsed = z
    .object({
      temperatureC: decimalString({ maxScale: 1, min: "-60", max: "60", allowNegative: true }),
      note: optionalText(300),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const t = await loadTrip(tx, ctx, tripId);
    if (!t.deliver) throw forbidden();
    assertTripStatus(t, ["IN_PROGRESS"], "TRIP_NOT_IN_PROGRESS");
    const excursion = await readingInTx(
      tx,
      ctx,
      t,
      parsed.data.temperatureC,
      parsed.data.note ?? null,
    );
    await audit(tx, ctx, "trip", t.id, "reading", { ...parsed.data, excursion });
    return { excursion };
  });
}

async function pendingStop(tx: Tx, ctx: TenantContext, t: { id: string }, stopId: string) {
  if (!isUuid(stopId)) throw notFound("Stop");
  const s = await tx.tripStop.findFirst({
    where: { organizationId: ctx.organizationId, tripId: t.id, id: stopId },
  });
  if (!s) throw notFound("Stop");
  if (s.status !== "PENDING")
    throw businessRuleViolation("STOP_ALREADY_RECORDED", "This stop is already recorded");
  return s;
}

export async function arriveAtStop(ctx: TenantContext, tripId: string, stopId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await loadTrip(tx, ctx, tripId);
    if (!t.deliver) throw forbidden();
    assertTripStatus(t, ["IN_PROGRESS"], "TRIP_NOT_IN_PROGRESS");
    const s = await pendingStop(tx, ctx, t, stopId);
    await tx.tripStop.update({
      where: { id: s.id },
      data: { arrivedAt: s.arrivedAt ?? new Date() },
    });
  });
}

/** Proof of delivery: who took it, the handover temperature (a reading too) and their signature. Final. */
export async function deliverStop(
  ctx: TenantContext,
  tripId: string,
  stopId: string,
  rawInput: unknown,
) {
  const parsed = podSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const pod = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const t = await loadTrip(tx, ctx, tripId);
    if (!t.deliver) throw forbidden();
    assertTripStatus(t, ["IN_PROGRESS"], "TRIP_NOT_IN_PROGRESS");
    const s = await pendingStop(tx, ctx, t, stopId);
    if (t.vehicle.refrigerated && pod.handoverTemperatureC === undefined)
      throw businessRuleViolation(
        "HANDOVER_TEMPERATURE_REQUIRED",
        "Record the temperature at handover",
        {
          field: "handoverTemperatureC",
        },
      );
    const now = new Date();
    await tx.tripStop.update({
      where: { id: s.id },
      data: {
        status: "DELIVERED",
        arrivedAt: s.arrivedAt ?? now,
        deliveredAt: now,
        recipientName: pod.recipientName,
        handoverTemperatureC: pod.handoverTemperatureC ?? null,
        signatureSvg: pod.signature ? normalizeSignature(pod.signature) : null,
        note: pod.note ?? null,
        recordedByUserId: ctx.userId,
      },
    });
    const excursion =
      pod.handoverTemperatureC !== undefined
        ? await readingInTx(tx, ctx, t, pod.handoverTemperatureC, `Handover, stop ${s.sequence}`)
        : false;
    await audit(tx, ctx, "trip", t.id, "delivered", {
      stopId: s.id,
      recipientName: pod.recipientName,
      excursion,
    });
    return { excursion };
  });
}

/** Not delivered (refused, closed, no access): the reason is kept; the goods come back with the vehicle. */
export async function failStop(
  ctx: TenantContext,
  tripId: string,
  stopId: string,
  rawInput: unknown,
) {
  const parsed = z.object({ reason: requiredText(300) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await loadTrip(tx, ctx, tripId);
    if (!t.deliver) throw forbidden();
    assertTripStatus(t, ["IN_PROGRESS"], "TRIP_NOT_IN_PROGRESS");
    const s = await pendingStop(tx, ctx, t, stopId);
    await tx.tripStop.update({
      where: { id: s.id },
      data: {
        status: "FAILED",
        arrivedAt: s.arrivedAt ?? new Date(),
        failureReason: parsed.data.reason,
        recordedByUserId: ctx.userId,
      },
    });
    await audit(tx, ctx, "trip", t.id, "failed_stop", { stopId: s.id, reason: parsed.data.reason });
  });
}

export async function completeTrip(ctx: TenantContext, tripId: string, rawInput: unknown = {}) {
  const parsed = z.object({ endOdometerKm: optionalKm }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await loadTrip(tx, ctx, tripId);
    if (!t.deliver) throw forbidden();
    assertTripStatus(t, ["IN_PROGRESS"], "TRIP_NOT_IN_PROGRESS");
    if (!allStopsResolved(t.stops))
      throw businessRuleViolation("TRIP_STOPS_OPEN", "Record every stop first");
    const end = parsed.data.endOdometerKm;
    if (end !== undefined && t.startOdometerKm !== null && end < t.startOdometerKm)
      throw businessRuleViolation("ODOMETER_BACKWARDS", "The odometer is below its start", {
        field: "endOdometerKm",
      });
    await tx.trip.update({
      where: { id: t.id },
      data: { status: "COMPLETED", completedAt: new Date(), endOdometerKm: end ?? null },
    });
    await audit(tx, ctx, "trip", t.id, "completed", parsed.data);
  });
}

/** Before it starts; its stops are freed for another trip. */
export async function cancelTrip(ctx: TenantContext, tripId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(300) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await loadTrip(tx, ctx, tripId);
    if (!t.plan) throw forbidden();
    assertTripStatus(t, ["PLANNED"], "TRIP_NOT_PLANNED");
    await tx.tripStop.deleteMany({ where: { organizationId: ctx.organizationId, tripId: t.id } });
    await tx.trip.update({
      where: { id: t.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: parsed.data.reason },
    });
    await audit(tx, ctx, "trip", t.id, "cancelled", parsed.data);
  });
}

const listSchema = z.object({
  date: z
    .string()
    .optional()
    .transform((v) => (v && isCalendarDate(v) ? v : undefined)),
  mine: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === "1" || v === "true"),
});

export async function listTrips(ctx: TenantContext, rawFilters: unknown = {}) {
  if (!canSeeLogistics(ctx)) throw forbidden();
  const f = listSchema.parse(rawFilters);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.trip.findMany({
      where: {
        organizationId: ctx.organizationId,
        warehouse: warehouseScope(ctx),
        ...(f.date ? { plannedOn: new Date(`${f.date}T00:00:00Z`) } : {}),
        ...(f.mine ? { driverUserId: ctx.userId } : {}),
      },
      include: {
        warehouse: { select: { code: true } },
        vehicle: { select: { code: true, plateNumber: true, refrigerated: true } },
        driver: { select: { name: true } },
        stops: { select: { status: true } },
        readings: { where: { excursion: true }, select: { id: true } },
      },
      orderBy: [{ plannedOn: "desc" }, { createdAt: "desc" }],
      take: 300,
    });
    return rows.map((t) => ({
      ...t,
      plannedOn: day(t.plannedOn),
      stopCount: t.stops.length,
      delivered: t.stops.filter((s) => s.status === "DELIVERED").length,
      failed: t.stops.filter((s) => s.status === "FAILED").length,
      excursions: t.readings.length,
    }));
  });
}

export async function getTrip(ctx: TenantContext, tripId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const base = await loadTrip(tx, ctx, tripId);
    const t = await tx.trip.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, id: base.id },
      include: {
        warehouse: { select: { id: true, code: true, name: true, branchId: true } },
        vehicle: true,
        driver: { select: { id: true, name: true } },
        readings: { orderBy: { readAt: "asc" } },
        stops: {
          orderBy: { sequence: "asc" },
          include: {
            customerDelivery: {
              select: {
                id: true,
                number: true,
                order: {
                  select: {
                    number: true,
                    customer: {
                      select: {
                        code: true,
                        name: true,
                        street: true,
                        district: true,
                        city: true,
                        phone: true,
                      },
                    },
                  },
                },
              },
            },
            stockShipment: {
              select: {
                id: true,
                number: true,
                to: { select: { code: true, name: true } },
              },
            },
          },
        },
      },
    });
    const consignments =
      base.plan && t.status === "PLANNED"
        ? await openConsignmentsInTx(tx, ctx, t.warehouseId)
        : { deliveries: [], transfers: [] };
    return {
      ...t,
      plannedOn: day(t.plannedOn),
      distanceKm: distanceKm(t.startOdometerKm, t.endOdometerKm),
      excursions: t.readings.filter((r) => r.excursion).length,
      consignments,
      canPlan: base.plan && t.status === "PLANNED",
      canDeliver: base.deliver,
    };
  });
}

/** What can still go on a trip from a warehouse: deliveries of the last 14 days and transfers in transit. */
async function openConsignmentsInTx(tx: Tx, ctx: TenantContext, warehouseId: string) {
  const since = new Date(`${addDays(businessDate(ctx.timeZone), -14)}T00:00:00Z`);
  const open = {
    none: { status: { in: ["PENDING", "DELIVERED"] as ("PENDING" | "DELIVERED")[] } },
  };
  const [deliveries, transfers] = await Promise.all([
    tx.customerDelivery.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: "POSTED",
        order: { warehouseId },
        deliveredAt: { gte: since },
        tripStops: open,
      },
      select: {
        id: true,
        number: true,
        order: { select: { customer: { select: { code: true, name: true } } } },
      },
      orderBy: { deliveredAt: "asc" },
      take: 200,
    }),
    tx.stockShipment.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: "IN_TRANSIT",
        fromWarehouseId: warehouseId,
        tripStops: open,
      },
      select: { id: true, number: true, to: { select: { code: true } } },
      orderBy: { number: "asc" },
      take: 200,
    }),
  ]);
  return { deliveries, transfers };
}
