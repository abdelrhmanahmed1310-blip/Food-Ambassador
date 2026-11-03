import "server-only";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString } from "@/lib/decimal";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import {
  optionalText,
  optionalUuidSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";
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
import { calibrationOutcome, dueState, nextDueDate } from "./equipment-rules";
import { loadBranch, openNonConformanceInTx } from "./service";

/**
 * Equipment, calibration and maintenance (DECISIONS.md ADR-099). Equipment
 * is registered per branch with the intervals the organization sets (none
 * assumed). Calibrations and maintenance are recorded as evidence and never
 * changed. A measured calibration passes or fails on its numbers; a failure
 * takes the equipment out of service and opens a non-conformance naming the
 * readings now in doubt; a later passing calibration returns it to service.
 */

export const EQUIPMENT_TYPES = [
  "THERMOMETER",
  "FRIDGE",
  "FREEZER",
  "OVEN",
  "HOT_HOLDING",
  "SCALE",
  "DISHWASHER",
  "EXTRACTION",
  "OTHER",
] as const;
export const MAINTENANCE_TYPES = ["PREVENTIVE", "REPAIR", "CLEANING", "INSPECTION"] as const;

const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);
const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const date = z
  .string()
  .transform((v) => v.trim())
  .refine(isCalendarDate, { error: "invalidDate" });
const optionalDate = z
  .string()
  .optional()
  .transform(blank)
  .refine((v) => v === undefined || isCalendarDate(v), { error: "invalidDate" });
const interval = z
  .string()
  .optional()
  .transform(blank)
  .refine((v) => v === undefined || /^\d{1,4}$/.test(v), { error: "invalidDays" })
  .transform((v) => (v === undefined ? null : Number(v)))
  .refine((v) => v === null || (v >= 1 && v <= 3650), { error: "invalidDays" });
const optionalNumber = z
  .string()
  .optional()
  .transform(blank)
  .pipe(
    decimalString({ maxScale: 3, min: "-999999", max: "999999", allowNegative: true }).optional(),
  );

const equipmentSchema = z.object({
  branchId: uuidSchema,
  code: z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .refine((v) => /^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(v), { error: "invalidCode" }),
  name: requiredText(160),
  type: z.enum(EQUIPMENT_TYPES, { error: "invalidOption" }),
  serialNumber: optionalText(80),
  location: optionalText(120),
  checkpointId: optionalUuidSchema,
  calibrationIntervalDays: interval,
  maintenanceIntervalDays: interval,
});
const intervalsSchema = z.object({
  calibrationIntervalDays: interval,
  maintenanceIntervalDays: interval,
  location: optionalText(120),
});
const calibrationSchema = z.object({
  performedOn: date,
  performedBy: requiredText(160),
  method: optionalText(200),
  referenceValue: optionalNumber,
  readingValue: optionalNumber,
  tolerance: z
    .string()
    .optional()
    .transform(blank)
    .pipe(decimalString({ maxScale: 3, min: "0", max: "999999" }).optional()),
  unit: optionalText(20),
  /** Only when nothing is measured (e.g. a supplier's certificate). */
  result: z
    .enum(["PASS", "FAIL"], { error: "invalidOption" })
    .optional()
    .or(z.literal("").transform(() => undefined)),
  certificateNo: optionalText(80),
  nextDueOn: optionalDate,
  note: optionalText(1000),
});
const maintenanceSchema = z.object({
  type: z.enum(MAINTENANCE_TYPES, { error: "invalidOption" }),
  performedOn: date,
  performedBy: requiredText(160),
  description: requiredText(1000),
  nextDueOn: optionalDate,
});
const reasonSchema = z.object({ reason: requiredText(500) });

async function load(
  tx: Tx,
  ctx: TenantContext,
  equipmentId: string,
  permission: "foodsafety.record" | "foodsafety.manage",
) {
  await tx.$queryRaw`SELECT 1 FROM "equipment" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${equipmentId}::uuid FOR UPDATE`;
  const eq = await tx.equipment.findFirst({
    where: { organizationId: ctx.organizationId, id: equipmentId },
  });
  if (!eq || !hasPermission(ctx.grants, "foodsafety.view", { branchId: eq.branchId }))
    throw notFound("Equipment");
  const branch = await loadBranch(tx, ctx, eq.branchId, permission);
  return { ...eq, branch };
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  eq: { id: string; code: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `equipment.${action}`,
    entityType: "equipment",
    entityId: eq.id,
    changes: { code: eq.code, ...changes },
  });
}

// ─── Register ───

export async function createEquipment(ctx: TenantContext, rawInput: unknown) {
  const parsed = equipmentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const branch = await loadBranch(tx, ctx, v.branchId, "foodsafety.manage");
      if (v.checkpointId) {
        const cp = await tx.safetyCheckpoint.count({
          where: { organizationId: ctx.organizationId, id: v.checkpointId, branchId: branch.id },
        });
        if (cp === 0)
          throw businessRuleViolation(
            "CHECKPOINT_OTHER_BRANCH",
            "The checkpoint is at another branch",
            {
              field: "checkpointId",
            },
          );
      }
      const eq = await tx.equipment.create({
        data: {
          organizationId: ctx.organizationId,
          branchId: branch.id,
          code: v.code,
          name: v.name,
          type: v.type,
          serialNumber: v.serialNumber ?? null,
          location: v.location ?? null,
          checkpointId: v.checkpointId ?? null,
          calibrationIntervalDays: v.calibrationIntervalDays,
          maintenanceIntervalDays: v.maintenanceIntervalDays,
          createdByUserId: ctx.userId,
        },
        select: { id: true, code: true },
      });
      await audit(tx, ctx, eq, "registered", { ...v });
      return eq;
    });
  } catch (error) {
    if (isUniqueViolation(error, "equipment_organization_id_branch_id_code_key"))
      throw conflict("This code is already used at the branch", {
        field: "code",
        reason: "codeTaken",
      });
    throw error;
  }
}

export async function updateEquipmentIntervals(
  ctx: TenantContext,
  equipmentId: string,
  rawInput: unknown,
) {
  const parsed = intervalsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const eq = await load(tx, ctx, equipmentId, "foodsafety.manage");
    await tx.equipment.update({
      where: { id: eq.id },
      data: {
        calibrationIntervalDays: parsed.data.calibrationIntervalDays,
        maintenanceIntervalDays: parsed.data.maintenanceIntervalDays,
        location: parsed.data.location ?? null,
      },
    });
    await audit(tx, ctx, eq, "updated", parsed.data);
  });
}

// ─── Calibration ───

export async function recordCalibration(
  ctx: TenantContext,
  equipmentId: string,
  rawInput: unknown,
) {
  const parsed = calibrationSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const eq = await load(tx, ctx, equipmentId, "foodsafety.record");
    if (eq.status === "RETIRED")
      throw businessRuleViolation("EQUIPMENT_RETIRED", "The equipment is retired");
    const today = businessDate(eq.branch.timeZone ?? ctx.timeZone);
    if (v.performedOn > today)
      throw businessRuleViolation("DATE_IN_FUTURE", "It cannot be recorded before it happens", {
        field: "performedOn",
      });
    const measured = v.referenceValue !== undefined || v.readingValue !== undefined;
    if (
      measured &&
      (v.referenceValue === undefined || v.readingValue === undefined || v.tolerance === undefined)
    )
      throw businessRuleViolation(
        "CALIBRATION_INCOMPLETE",
        "Give the reference value, the reading and the tolerance together",
        {
          field:
            v.referenceValue === undefined
              ? "referenceValue"
              : v.readingValue === undefined
                ? "readingValue"
                : "tolerance",
        },
      );
    const result = measured
      ? calibrationOutcome(
          new Decimal(v.referenceValue!),
          new Decimal(v.readingValue!),
          new Decimal(v.tolerance!),
        )
      : v.result;
    if (!result)
      throw businessRuleViolation("CALIBRATION_RESULT_REQUIRED", "Say whether it passed", {
        field: "result",
      });
    const nextDueOn =
      result === "PASS"
        ? nextDueDate(v.performedOn, v.nextDueOn, eq.calibrationIntervalDays)
        : null;
    if (nextDueOn && nextDueOn <= v.performedOn)
      throw businessRuleViolation("NEXT_DUE_BEFORE", "The next date must come after this one", {
        field: "nextDueOn",
      });

    let nc: { id: string; number: string } | null = null;
    if (result === "FAIL") {
      const lastPass = await tx.calibration.findFirst({
        where: { organizationId: ctx.organizationId, equipmentId: eq.id, result: "PASS" },
        orderBy: { performedOn: "desc" },
        select: { performedOn: true },
      });
      nc = await openNonConformanceInTx(tx, ctx, {
        branchId: eq.branchId,
        timeZone: eq.branch.timeZone,
        title: `Calibration failed: ${eq.code} — ${eq.name}`,
        description: [
          measured
            ? `Reference ${v.referenceValue}${v.unit ? ` ${v.unit}` : ""}, read ${v.readingValue}, allowed ±${v.tolerance}.`
            : "Failed check.",
          lastPass
            ? `Measurements made with it since the last passing calibration on ${day(lastPass.performedOn)} are in doubt.`
            : "It has no passing calibration on record: its measurements are in doubt.",
          ...(v.note ? [v.note] : []),
        ].join("\n"),
        // Equipment that monitors a checkpoint affects food safety records directly.
        severity: eq.checkpointId ? "HIGH" : "MEDIUM",
        source: "EQUIPMENT",
      });
    }
    const row = await tx.calibration.create({
      data: {
        organizationId: ctx.organizationId,
        equipmentId: eq.id,
        performedOn: asDate(v.performedOn),
        performedBy: v.performedBy,
        method: v.method ?? null,
        referenceValue: v.referenceValue ?? null,
        readingValue: v.readingValue ?? null,
        tolerance: v.tolerance ?? null,
        unit: v.unit ?? null,
        result,
        certificateNo: v.certificateNo ?? null,
        nextDueOn: nextDueOn ? asDate(nextDueOn) : null,
        note: v.note ?? null,
        nonConformanceId: nc?.id ?? null,
        recordedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    const now = new Date();
    if (result === "FAIL")
      await tx.equipment.update({
        where: { id: eq.id },
        data: {
          status: "OUT_OF_SERVICE",
          statusReason: `Calibration failed (${nc!.number})`,
          statusChangedAt: now,
        },
      });
    else if (eq.status === "OUT_OF_SERVICE")
      await tx.equipment.update({
        where: { id: eq.id },
        data: { status: "ACTIVE", statusReason: null, statusChangedAt: now },
      });
    await audit(tx, ctx, eq, "calibrated", {
      ...v,
      result,
      nextDueOn,
      nonConformance: nc?.number ?? null,
    });
    return { id: row.id, result, nextDueOn, nonConformance: nc };
  });
}

// ─── Maintenance and status ───

export async function recordMaintenance(
  ctx: TenantContext,
  equipmentId: string,
  rawInput: unknown,
) {
  const parsed = maintenanceSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const eq = await load(tx, ctx, equipmentId, "foodsafety.record");
    if (eq.status === "RETIRED")
      throw businessRuleViolation("EQUIPMENT_RETIRED", "The equipment is retired");
    if (v.performedOn > businessDate(eq.branch.timeZone ?? ctx.timeZone))
      throw businessRuleViolation("DATE_IN_FUTURE", "It cannot be recorded before it happens", {
        field: "performedOn",
      });
    const nextDueOn = nextDueDate(v.performedOn, v.nextDueOn, eq.maintenanceIntervalDays);
    if (nextDueOn && nextDueOn <= v.performedOn)
      throw businessRuleViolation("NEXT_DUE_BEFORE", "The next date must come after this one", {
        field: "nextDueOn",
      });
    const row = await tx.maintenanceRecord.create({
      data: {
        organizationId: ctx.organizationId,
        equipmentId: eq.id,
        type: v.type,
        performedOn: asDate(v.performedOn),
        performedBy: v.performedBy,
        description: v.description,
        nextDueOn: nextDueOn ? asDate(nextDueOn) : null,
        recordedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await audit(tx, ctx, eq, "maintained", { ...v, nextDueOn });
    return { id: row.id, nextDueOn };
  });
}

export async function setEquipmentOutOfService(
  ctx: TenantContext,
  equipmentId: string,
  rawInput: unknown,
) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const eq = await load(tx, ctx, equipmentId, "foodsafety.record");
    if (eq.status !== "ACTIVE")
      throw businessRuleViolation("EQUIPMENT_NOT_ACTIVE", "The equipment is not in service");
    await tx.equipment.update({
      where: { id: eq.id },
      data: {
        status: "OUT_OF_SERVICE",
        statusReason: parsed.data.reason,
        statusChangedAt: new Date(),
      },
    });
    await audit(tx, ctx, eq, "out_of_service", { reason: parsed.data.reason });
  });
}

/** Back in service; refused while its latest calibration failed (a passing calibration does it instead). */
export async function returnEquipmentToService(ctx: TenantContext, equipmentId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const eq = await load(tx, ctx, equipmentId, "foodsafety.manage");
    if (eq.status !== "OUT_OF_SERVICE")
      throw businessRuleViolation(
        "EQUIPMENT_NOT_OUT_OF_SERVICE",
        "The equipment is not out of service",
      );
    const last = await tx.calibration.findFirst({
      where: { organizationId: ctx.organizationId, equipmentId: eq.id },
      orderBy: [{ performedOn: "desc" }, { recordedAt: "desc" }],
      select: { result: true },
    });
    if (last?.result === "FAIL")
      throw businessRuleViolation(
        "CALIBRATION_NEEDED",
        "Its last calibration failed: record a passing one",
      );
    await tx.equipment.update({
      where: { id: eq.id },
      data: { status: "ACTIVE", statusReason: null, statusChangedAt: new Date() },
    });
    await audit(tx, ctx, eq, "returned_to_service");
  });
}

export async function retireEquipment(ctx: TenantContext, equipmentId: string, rawInput: unknown) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const eq = await load(tx, ctx, equipmentId, "foodsafety.manage");
    if (eq.status === "RETIRED")
      throw businessRuleViolation("EQUIPMENT_RETIRED", "The equipment is retired");
    await tx.equipment.update({
      where: { id: eq.id },
      data: { status: "RETIRED", statusReason: parsed.data.reason, statusChangedAt: new Date() },
    });
    await audit(tx, ctx, eq, "retired", { reason: parsed.data.reason });
  });
}

// ─── Reading ───

function branchWhere(ctx: TenantContext) {
  const s = accessibleScope(ctx.grants, "foodsafety.view");
  return s.all ? {} : { branchId: { in: s.branchIds } };
}

/** When calibration and maintenance are next due: the latest record's date, else (with an interval) now. */
function dues(
  eq: {
    calibrationIntervalDays: number | null;
    maintenanceIntervalDays: number | null;
    createdAt: Date;
  },
  lastCal: { nextDueOn: Date | null; result: string } | undefined,
  lastMaint: { nextDueOn: Date | null } | undefined,
  today: string,
) {
  const cal = lastCal
    ? lastCal.nextDueOn
      ? day(lastCal.nextDueOn)
      : null
    : eq.calibrationIntervalDays
      ? day(eq.createdAt)
      : null;
  const maint = lastMaint
    ? lastMaint.nextDueOn
      ? day(lastMaint.nextDueOn)
      : null
    : eq.maintenanceIntervalDays
      ? day(eq.createdAt)
      : null;
  return {
    calibrationDue: cal,
    calibrationState: dueState(cal, today),
    maintenanceDue: maint,
    maintenanceState: dueState(maint, today),
  };
}

export async function listEquipment(
  ctx: TenantContext,
  filters: { includeRetired?: boolean } = {},
) {
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) throw forbidden();
  const today = businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.equipment.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...branchWhere(ctx),
        ...(filters.includeRetired ? {} : { status: { not: "RETIRED" } }),
      },
      include: {
        branch: { select: { code: true, name: true } },
        calibrations: { orderBy: [{ performedOn: "desc" }, { recordedAt: "desc" }], take: 1 },
        maintenance: { orderBy: [{ performedOn: "desc" }, { recordedAt: "desc" }], take: 1 },
      },
      orderBy: [{ branch: { code: "asc" } }, { code: "asc" }],
    });
    return rows.map((e) => ({
      ...e,
      lastCalibration: e.calibrations[0] ?? null,
      ...dues(e, e.calibrations[0], e.maintenance[0], today),
    }));
  });
}

export async function getEquipment(ctx: TenantContext, equipmentId: string) {
  const today = businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await tx.equipment.findFirst({
      where: { organizationId: ctx.organizationId, id: equipmentId },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        checkpoint: { select: { id: true, code: true, name: true } },
        calibrations: {
          include: { nonConformance: { select: { id: true, number: true } } },
          orderBy: [{ performedOn: "desc" }, { recordedAt: "desc" }],
        },
        maintenance: { orderBy: [{ performedOn: "desc" }, { recordedAt: "desc" }] },
      },
    });
    if (!e || !hasPermission(ctx.grants, "foodsafety.view", { branchId: e.branchId }))
      throw notFound("Equipment");
    const record = hasPermission(ctx.grants, "foodsafety.record", { branchId: e.branchId });
    const manage = hasPermission(ctx.grants, "foodsafety.manage", { branchId: e.branchId });
    return {
      equipment: e,
      ...dues(e, e.calibrations[0], e.maintenance[0], today),
      can: {
        record: record && e.status !== "RETIRED",
        outOfService: record && e.status === "ACTIVE",
        returnToService:
          manage && e.status === "OUT_OF_SERVICE" && e.calibrations[0]?.result !== "FAIL",
        manage: manage && e.status !== "RETIRED",
      },
    };
  });
}

/** Attention list: calibrations and maintenance overdue, equipment out of service. */
export async function equipmentAttention(ctx: TenantContext) {
  const items = await listEquipment(ctx);
  return {
    overdue: items.filter(
      (e) => e.calibrationState === "OVERDUE" || e.maintenanceState === "OVERDUE",
    ).length,
    dueSoon: items.filter(
      (e) => e.calibrationState === "DUE_SOON" || e.maintenanceState === "DUE_SOON",
    ).length,
    outOfService: items.filter((e) => e.status === "OUT_OF_SERVICE").length,
  };
}
