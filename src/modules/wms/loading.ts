import "server-only";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { deliverPickListInTx, lockList } from "./picking";

/**
 * Packing and loading (DECISIONS.md ADR-103). Picked stock is packed into
 * numbered units (carton, crate, pallet, bag) with their exact contents. A
 * load is one vehicle trip from a warehouse; fully packed pick lists are put
 * on it, every unit is confirmed loaded (by click or by its number, ready for
 * scanning), and dispatching the load records the vehicle temperature
 * (required with chilled or frozen goods) and seal, and delivers all its
 * orders at once. Packing and loading need `inventory.transfer` at the
 * warehouse; dispatch also needs `b2b.manage`.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export const PACK_UNIT_TYPES = ["CARTON", "CRATE", "PALLET", "BAG", "OTHER"] as const;

const packSchema = z.object({
  type: z.enum(PACK_UNIT_TYPES, { error: "invalidOption" }),
  grossWeightKg: z
    .string()
    .optional()
    .transform(blank)
    .pipe(decimalString({ maxScale: 3, min: "0.001", max: "100000" }).optional()),
  note: optionalText(500),
  /** Empty = everything still unpacked goes into this unit. */
  lines: z
    .array(
      z.object({
        pickListLineId: uuidSchema,
        quantity: z
          .string()
          .optional()
          .transform(blank)
          .pipe(decimalString({ maxScale: 6, min: "0" }).optional()),
      }),
    )
    .max(500)
    .optional()
    .default([]),
});
const loadSchema = z.object({
  warehouseId: uuidSchema,
  vehicleRef: requiredText(60),
  driverName: optionalText(120),
  note: optionalText(500),
});
const loadedSchema = z.object({ unit: requiredText(60) });
const dispatchSchema = z.object({
  vehicleTemperatureCelsius: z
    .string()
    .optional()
    .transform(blank)
    .pipe(decimalString({ maxScale: 1, min: "-40", max: "60", allowNegative: true }).optional()),
  sealNumber: optionalText(60),
  note: optionalText(500),
});
const cancelSchema = z.object({ reason: requiredText(500) });

const scopeOf = (wh: { id: string; branchId: string }) => ({
  branchId: wh.branchId,
  warehouseId: wh.id,
});

/** Packed quantity per pick list line, from the list's units. */
async function packedByLine(tx: Tx, ctx: TenantContext, pickListId: string) {
  const rows = await tx.packUnitLine.groupBy({
    by: ["pickListLineId"],
    where: { organizationId: ctx.organizationId, packUnit: { pickListId } },
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [r.pickListLineId, dec(r._sum.quantity ?? 0)]));
}

/** Lines still to pack, and whether the list is completely packed. */
export async function packingState(tx: Tx, ctx: TenantContext, pickListId: string) {
  const lines = await tx.pickListLine.findMany({
    where: { organizationId: ctx.organizationId, pickListId },
    select: { id: true, pickedQuantity: true },
  });
  const packed = await packedByLine(tx, ctx, pickListId);
  const remaining = new Map(
    lines.map((l) => [l.id, dec(l.pickedQuantity ?? 0).minus(packed.get(l.id) ?? new Decimal(0))]),
  );
  return {
    packed,
    remaining,
    complete: [...remaining.values()].every((r) => r.lte(0)) && packed.size > 0,
  };
}

/** Pack picked stock into one numbered unit. */
export async function packUnit(ctx: TenantContext, pickListId: string, rawInput: unknown) {
  const parsed = packSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { list, wh } = await lockList(tx, ctx, pickListId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    if (list.status !== "PICKED")
      throw businessRuleViolation("PICK_LIST_STATUS", "Only picked lists are packed", {
        status: list.status,
      });
    if (list.loadId)
      throw businessRuleViolation("PICK_LIST_ON_LOAD", "The list is already on a load");
    const { remaining } = await packingState(tx, ctx, list.id);
    const wanted =
      input.lines.length === 0
        ? [...remaining.entries()]
            .filter(([, r]) => r.gt(0))
            .map(([id, r]) => ({ pickListLineId: id, quantity: r }))
        : input.lines
            .filter((l) => l.quantity !== undefined && new Decimal(l.quantity).gt(0))
            .map((l) => ({ pickListLineId: l.pickListLineId, quantity: new Decimal(l.quantity!) }));
    if (wanted.length === 0) throw businessRuleViolation("NOTHING_TO_PACK", "Nothing left to pack");
    for (const w of wanted) {
      const left = remaining.get(w.pickListLineId);
      if (left === undefined) throw notFound("Pick list line");
      if (w.quantity.gt(left))
        throw businessRuleViolation("PACK_MORE_THAN_PICKED", "More than is left to pack", {
          remaining: left.toFixed(),
        });
    }
    const today = businessDate(wh.branch.timeZone ?? ctx.timeZone);
    const number = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      "PKU",
      Number(today.slice(0, 4)),
    );
    const unit = await tx.packUnit.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        pickListId: list.id,
        type: input.type,
        grossWeightKg: input.grossWeightKg ?? null,
        note: input.note ?? null,
        createdByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    await tx.packUnitLine.createMany({
      data: wanted.map((w) => ({
        organizationId: ctx.organizationId,
        packUnitId: unit.id,
        pickListLineId: w.pickListLineId,
        quantity: w.quantity.toFixed(),
      })),
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "pack_unit.created",
      entityType: "pick_list",
      entityId: list.id,
      changes: { unit: number, type: input.type, lines: wanted.length },
    });
    return unit;
  });
}

/** Unpack a unit that is not on a load. */
export async function removePackUnit(ctx: TenantContext, unitId: string) {
  if (!isUuid(unitId)) throw notFound("Pack unit");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const unit = await tx.packUnit.findFirst({
      where: { organizationId: ctx.organizationId, id: unitId },
      select: { id: true, number: true, pickListId: true },
    });
    if (!unit) throw notFound("Pack unit");
    const { list, wh } = await lockList(tx, ctx, unit.pickListId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    if (list.status !== "PICKED" || list.loadId)
      throw businessRuleViolation("PACK_UNIT_FIXED", "The unit is on a load or already delivered");
    await tx.packUnit.delete({ where: { id: unit.id } });
    await recordAudit(tx, actorOf(ctx), {
      action: "pack_unit.removed",
      entityType: "pick_list",
      entityId: list.id,
      changes: { unit: unit.number },
    });
  });
}

async function warehouseFor(tx: Tx, ctx: TenantContext, warehouseId: string) {
  const wh = await tx.warehouse.findFirst({
    where: { organizationId: ctx.organizationId, id: warehouseId },
    select: {
      id: true,
      code: true,
      name: true,
      branchId: true,
      archivedAt: true,
      branch: { select: { timeZone: true } },
    },
  });
  if (
    !wh ||
    !hasPermission(ctx.grants, "inventory.view", { branchId: wh.branchId, warehouseId: wh.id })
  )
    throw notFound("Warehouse");
  return wh;
}

export async function createLoad(ctx: TenantContext, rawInput: unknown) {
  const parsed = loadSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wh = await warehouseFor(tx, ctx, input.warehouseId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    const today = businessDate(wh.branch.timeZone ?? ctx.timeZone);
    const number = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      "LOD",
      Number(today.slice(0, 4)),
    );
    const load = await tx.load.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        warehouseId: wh.id,
        vehicleRef: input.vehicleRef,
        driverName: input.driverName ?? null,
        note: input.note ?? null,
        createdByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "load.created",
      entityType: "load",
      entityId: load.id,
      changes: { number, ...input },
    });
    return load;
  });
}

async function lockLoad(tx: Tx, ctx: TenantContext, loadId: string) {
  if (!isUuid(loadId)) throw notFound("Load");
  const found = await tx.load.findFirst({
    where: { organizationId: ctx.organizationId, id: loadId },
    select: { id: true },
  });
  if (!found) throw notFound("Load");
  await tx.$executeRaw`SELECT 1 FROM "loads" WHERE "id" = ${loadId}::uuid FOR UPDATE`;
  const load = await tx.load.findFirstOrThrow({ where: { id: loadId } });
  const wh = await warehouseFor(tx, ctx, load.warehouseId);
  return { load, wh };
}

function requireOpen(status: string) {
  if (status !== "OPEN")
    throw businessRuleViolation("LOAD_NOT_OPEN", "The load is no longer open", { status });
}

/** Put a fully packed, picked list on the load. */
export async function addToLoad(ctx: TenantContext, loadId: string, pickListId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { load, wh } = await lockLoad(tx, ctx, loadId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    requireOpen(load.status);
    const { list } = await lockList(tx, ctx, pickListId);
    if (list.warehouseId !== load.warehouseId)
      throw businessRuleViolation("PICK_WRONG_WAREHOUSE", "The list ships from another warehouse", {
        number: list.number,
      });
    if (list.status !== "PICKED")
      throw businessRuleViolation("PICK_LIST_STATUS", "Only picked lists are loaded", {
        status: list.status,
      });
    if (list.loadId)
      throw businessRuleViolation("PICK_LIST_ON_LOAD", "The list is already on a load");
    if (!(await packingState(tx, ctx, list.id)).complete)
      throw businessRuleViolation("PACKING_INCOMPLETE", "Pack everything picked first", {
        number: list.number,
      });
    await tx.pickList.update({ where: { id: list.id }, data: { loadId: load.id } });
    await recordAudit(tx, actorOf(ctx), {
      action: "load.list_added",
      entityType: "load",
      entityId: load.id,
      changes: { number: load.number, pickList: list.number },
    });
  });
}

export async function removeFromLoad(ctx: TenantContext, loadId: string, pickListId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { load, wh } = await lockLoad(tx, ctx, loadId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    requireOpen(load.status);
    const { list } = await lockList(tx, ctx, pickListId);
    if (list.loadId !== load.id) throw notFound("Pick list");
    await tx.packUnit.updateMany({
      where: { organizationId: ctx.organizationId, pickListId: list.id },
      data: { loadedAt: null, loadedByUserId: null },
    });
    await tx.pickList.update({ where: { id: list.id }, data: { loadId: null } });
    await recordAudit(tx, actorOf(ctx), {
      action: "load.list_removed",
      entityType: "load",
      entityId: load.id,
      changes: { number: load.number, pickList: list.number },
    });
  });
}

/** Confirm one unit is on the vehicle, by its id or its number (as a scanner would send). */
export async function confirmLoaded(ctx: TenantContext, loadId: string, rawInput: unknown) {
  const parsed = loadedSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const ref = parsed.data.unit;
  const byNumber = ref.toUpperCase();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { load, wh } = await lockLoad(tx, ctx, loadId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    requireOpen(load.status);
    const unit = await tx.packUnit.findFirst({
      where: {
        organizationId: ctx.organizationId,
        ...(isUuid(ref) ? { id: ref } : { number: byNumber }),
      },
      select: { id: true, number: true, loadedAt: true, pickList: { select: { loadId: true } } },
    });
    if (!unit || unit.pickList.loadId !== load.id)
      throw businessRuleViolation("PACK_UNIT_NOT_ON_LOAD", "This unit is not on this load", {
        unit: ref,
      });
    if (unit.loadedAt)
      throw businessRuleViolation("ALREADY_LOADED", "This unit is already loaded", {
        unit: unit.number,
      });
    await tx.packUnit.update({
      where: { id: unit.id },
      data: { loadedAt: new Date(), loadedByUserId: ctx.userId },
    });
    return { number: unit.number };
  });
}

/** Everything loaded: record the vehicle check and deliver every order on the load. */
export async function dispatchLoad(ctx: TenantContext, loadId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "b2b.manage");
  const parsed = dispatchSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { load, wh } = await lockLoad(tx, ctx, loadId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    requireOpen(load.status);
    const lists = await tx.pickList.findMany({
      where: { organizationId: ctx.organizationId, loadId: load.id },
      select: { id: true },
      orderBy: { number: "asc" },
    });
    if (lists.length === 0) throw businessRuleViolation("LOAD_EMPTY", "The load is empty");
    const units = await tx.packUnit.findMany({
      where: { organizationId: ctx.organizationId, pickList: { loadId: load.id } },
      select: { number: true, loadedAt: true },
    });
    const missing = units.filter((u) => !u.loadedAt);
    if (missing.length > 0)
      throw businessRuleViolation("LOAD_NOT_FULLY_LOADED", "Confirm every unit loaded first", {
        missing: missing.length,
        units: missing.map((u) => u.number).join(", "),
      });
    const cold = await tx.pickListLine.count({
      where: {
        organizationId: ctx.organizationId,
        pickList: { loadId: load.id },
        product: { storageRequirement: { in: ["CHILLED", "FROZEN"] } },
      },
    });
    if (cold > 0 && input.vehicleTemperatureCelsius === undefined)
      throw businessRuleViolation(
        "VEHICLE_TEMPERATURE_REQUIRED",
        "Record the vehicle temperature for chilled or frozen goods",
        { field: "vehicleTemperatureCelsius" },
      );
    const deliveries = [];
    for (const l of lists) {
      const { list } = await lockList(tx, ctx, l.id);
      deliveries.push(await deliverPickListInTx(tx, ctx, list));
    }
    await tx.load.update({
      where: { id: load.id },
      data: {
        status: "DISPATCHED",
        vehicleTemperatureCelsius: input.vehicleTemperatureCelsius ?? null,
        sealNumber: input.sealNumber ?? null,
        note: input.note ?? load.note,
        dispatchedAt: new Date(),
        dispatchedByUserId: ctx.userId,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "load.dispatched",
      entityType: "load",
      entityId: load.id,
      changes: {
        number: load.number,
        deliveries: deliveries.map((d) => d.number),
        vehicleTemperatureCelsius: input.vehicleTemperatureCelsius ?? null,
        sealNumber: input.sealNumber ?? null,
      },
    });
    return { deliveries };
  });
}

/** Drop an open load; its lists stay picked and packed, ready for another load. */
export async function cancelLoad(ctx: TenantContext, loadId: string, rawInput: unknown) {
  const parsed = cancelSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { load, wh } = await lockLoad(tx, ctx, loadId);
    assertPermission(ctx.grants, "inventory.transfer", scopeOf(wh));
    requireOpen(load.status);
    await tx.packUnit.updateMany({
      where: { organizationId: ctx.organizationId, pickList: { loadId: load.id } },
      data: { loadedAt: null, loadedByUserId: null },
    });
    await tx.pickList.updateMany({
      where: { organizationId: ctx.organizationId, loadId: load.id },
      data: { loadId: null },
    });
    await tx.load.update({
      where: { id: load.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: parsed.data.reason },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "load.cancelled",
      entityType: "load",
      entityId: load.id,
      changes: { number: load.number, reason: parsed.data.reason },
    });
  });
}

export async function listLoads(ctx: TenantContext, filters: { status?: "open" | "all" } = {}) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const loads = await tx.load.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(filters.status === "all" ? {} : { status: "OPEN" }),
      },
      include: {
        warehouse: { select: { code: true, branchId: true } },
        _count: { select: { pickLists: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return loads.filter((l) =>
      hasPermission(ctx.grants, "inventory.view", {
        branchId: l.warehouse.branchId,
        warehouseId: l.warehouseId,
      }),
    );
  });
}

export async function getLoad(ctx: TenantContext, loadId: string) {
  if (!isUuid(loadId)) throw notFound("Load");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const load = await tx.load.findFirst({
      where: { organizationId: ctx.organizationId, id: loadId },
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        pickLists: {
          orderBy: { number: "asc" },
          include: {
            salesOrder: {
              select: {
                id: true,
                number: true,
                customer: { select: { code: true, name: true, address: true } },
              },
            },
            delivery: { select: { id: true, number: true } },
            packUnits: {
              orderBy: { number: "asc" },
              include: {
                lines: {
                  include: {
                    pickListLine: {
                      select: {
                        product: {
                          select: {
                            sku: true,
                            nameEn: true,
                            nameAr: true,
                            storageRequirement: true,
                            baseUom: { select: { code: true } },
                          },
                        },
                        lot: { select: { lotCode: true, expiresOn: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!load) throw notFound("Load");
    const wh = await warehouseFor(tx, ctx, load.warehouseId);
    // Picked lists of this warehouse that could still go on the load.
    const candidates =
      load.status === "OPEN"
        ? await tx.pickList.findMany({
            where: {
              organizationId: ctx.organizationId,
              warehouseId: load.warehouseId,
              status: "PICKED",
              loadId: null,
            },
            select: {
              id: true,
              number: true,
              salesOrder: { select: { number: true, customer: { select: { name: true } } } },
            },
            orderBy: { number: "asc" },
          })
        : [];
    const units = load.pickLists.flatMap((l) => l.packUnits);
    return {
      ...load,
      candidates,
      unitCount: units.length,
      loadedCount: units.filter((u) => u.loadedAt).length,
      hasCold: load.pickLists.some((l) =>
        l.packUnits.some((u) =>
          u.lines.some((x) => x.pickListLine.product.storageRequirement !== "AMBIENT"),
        ),
      ),
      canLoad: hasPermission(ctx.grants, "inventory.transfer", scopeOf(wh)),
      canDispatch:
        hasPermission(ctx.grants, "inventory.transfer", scopeOf(wh)) &&
        hasPermission(ctx.grants, "b2b.manage"),
    };
  });
}
