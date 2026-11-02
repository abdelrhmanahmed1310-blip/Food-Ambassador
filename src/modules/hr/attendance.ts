import "server-only";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { isCalendarDate } from "@/lib/dates";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { encryptSecret, integrationKey, newSecret } from "@/modules/integrations/crypto";
import {
  verifyInbound,
  type InboundInput,
  type InboundResult,
} from "@/modules/integrations/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { zonedInstant } from "@/modules/pos/pickup-rules";
import { requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import { consumeRateLimit } from "@/server/rate-limit";
import {
  distanceMeters,
  localDay,
  nextKind,
  PIN_LOCK_MINUTES,
  PIN_MAX_FAILURES,
  PIN_PATTERN,
  timesheet,
  type PunchKind,
} from "./attendance-rules";
import { canViewHr } from "./service";

/**
 * Time and attendance (DECISIONS.md ADR-080). Every way of clocking in ends
 * as an immutable punch: the branch tablet (employee number + PIN), the
 * employee's phone (signed in; within the branch's radius when one is set),
 * a fingerprint or face device (signed webhook, repeats ignored), or HR by
 * hand with a reason. Wrong punches are voided, never edited.
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const TOKEN = /^[A-Za-z0-9_-]{24,64}$/;
const deviceKey = () => {
  const env = getEnv();
  return integrationKey(env.INTEGRATION_ENCRYPTION_KEY, env.AUTH_SECRET);
};

async function hashPin(pin: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
async function pinMatches(pin: string, stored: string) {
  const [, salt, hash] = stored.split("$");
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(pin, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

const canManageBranch = (ctx: TenantContext, branchId: string) =>
  hasPermission(ctx.grants, "hr.manage", { branchId });
function viewBranches(ctx: TenantContext): Prisma.EmployeeWhereInput {
  const v = accessibleScope(ctx.grants, "hr.view");
  const m = accessibleScope(ctx.grants, "hr.manage");
  if (v.all || m.all) return {};
  return { branchId: { in: [...v.branchIds, ...m.branchIds] } };
}

async function loadBranch(tx: Tx, ctx: TenantContext, branchId: string) {
  const id = uuidSchema.safeParse(branchId);
  if (!id.success) throw notFound("Branch");
  const b = await tx.branch.findFirst({
    where: { organizationId: ctx.organizationId, id: id.data, archivedAt: null },
  });
  if (!b) throw notFound("Branch");
  return b;
}

async function loadEmployeeFor(tx: Tx, ctx: TenantContext, employeeId: string, manage: boolean) {
  const id = uuidSchema.safeParse(employeeId);
  if (!id.success) throw notFound("Employee");
  const e = await tx.employee.findFirst({
    where: { organizationId: ctx.organizationId, id: id.data, AND: [viewBranches(ctx)] },
  });
  if (!e) throw notFound("Employee");
  if (manage && !canManageBranch(ctx, e.branchId)) throw forbidden();
  return e;
}

/** The last punch that counts, to decide whether a tap is a clock-in or a clock-out. */
async function lastKind(tx: Tx, organizationId: string, employeeId: string, before?: Date) {
  const last = await tx.attendancePunch.findFirst({
    where: {
      organizationId,
      employeeId,
      voidedAt: null,
      ...(before ? { at: { lte: before } } : {}),
    },
    orderBy: { at: "desc" },
    select: { kind: true },
  });
  return (last?.kind ?? null) as PunchKind | null;
}

/** One punch at a time per employee, so two taps cannot both clock in. */
async function lockEmployee(tx: Tx, organizationId: string, employeeId: string) {
  await tx.$queryRaw`SELECT 1 FROM "employees" WHERE "organization_id" = ${organizationId}::uuid AND "id" = ${employeeId}::uuid FOR UPDATE`;
}

// ─── PINs ───

const pinSchema = z.object({
  pin: z.string().trim().regex(PIN_PATTERN, { error: "pinFormat" }),
});

export async function setEmployeePin(ctx: TenantContext, employeeId: string, rawInput: unknown) {
  const parsed = pinSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const pinHash = await hashPin(parsed.data.pin);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployeeFor(tx, ctx, employeeId, true);
    await tx.employee.update({
      where: { id: e.id },
      data: { pinHash, pinFailures: 0, pinLockedUntil: null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "employee.pin_set",
      entityType: "employee",
      entityId: e.id,
      changes: {},
    });
  });
}

// ─── Branch tablets ───

const terminalSchema = z.object({ branchId: uuidSchema, name: requiredText(80) });

export async function createTerminal(ctx: TenantContext, rawInput: unknown) {
  const parsed = terminalSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  if (!canManageBranch(ctx, v.branchId)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const b = await loadBranch(tx, ctx, v.branchId);
    const t = await tx.attendanceTerminal.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: b.id,
        name: v.name,
        publicToken: randomBytes(24).toString("base64url"),
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "attendance_terminal.created",
      entityType: "attendance_terminal",
      entityId: t.id,
      changes: { branchId: b.id, name: v.name },
    });
    return t;
  });
}

export async function setTerminalActive(ctx: TenantContext, terminalId: string, active: boolean) {
  const id = uuidSchema.safeParse(terminalId);
  if (!id.success) throw notFound("Terminal");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const t = await tx.attendanceTerminal.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data },
    });
    if (!t) throw notFound("Terminal");
    if (!canManageBranch(ctx, t.branchId)) throw forbidden();
    await tx.attendanceTerminal.update({ where: { id: t.id }, data: { active } });
    await recordAudit(tx, actorOf(ctx), {
      action: active ? "attendance_terminal.activated" : "attendance_terminal.deactivated",
      entityType: "attendance_terminal",
      entityId: t.id,
      changes: {},
    });
  });
}

// ─── Branch location for phone clock-in ───

const geofenceSchema = z.object({
  latitude: z.coerce.number({ error: "invalid" }).min(-90).max(90),
  longitude: z.coerce.number({ error: "invalid" }).min(-180).max(180),
  radiusMeters: z.coerce.number({ error: "invalid" }).int().min(20).max(5000),
});

/** Set (or, with null, remove) where staff may clock in from their phones. */
export async function setGeofence(ctx: TenantContext, branchId: string, rawInput: unknown | null) {
  if (!canManageBranch(ctx, branchId)) throw forbidden();
  const parsed = rawInput === null ? null : geofenceSchema.safeParse(rawInput);
  if (parsed && !parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const b = await loadBranch(tx, ctx, branchId);
    if (!parsed)
      await tx.branchGeofence.deleteMany({
        where: { organizationId: ctx.organizationId, branchId: b.id },
      });
    else {
      const data = {
        latitude: parsed.data.latitude.toFixed(6),
        longitude: parsed.data.longitude.toFixed(6),
        radiusMeters: parsed.data.radiusMeters,
      };
      await tx.branchGeofence.upsert({
        where: { branchId: b.id },
        create: { organizationId: ctx.organizationId, branchId: b.id, ...data },
        update: data,
      });
    }
    await recordAudit(tx, actorOf(ctx), {
      action: parsed ? "branch_geofence.set" : "branch_geofence.removed",
      entityType: "branch",
      entityId: b.id,
      changes: parsed ? { radiusMeters: parsed.data.radiusMeters } : {},
    });
  });
}

// ─── Clocking in ───

const terminalClockSchema = z.object({
  employeeNumber: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .transform((v) => v.toUpperCase()),
  pin: z.string().trim().max(10),
});

export type ClockResult =
  | { ok: true; firstName: string; kind: PunchKind; at: Date }
  | { ok: false; error: "INVALID" | "LOCKED" | "RATE_LIMITED" | "NOT_ACTIVE" };

export async function terminalInfo(publicToken: string) {
  if (!TOKEN.test(publicToken)) return null;
  return withSystemTx((tx) =>
    tx.attendanceTerminal.findFirst({
      where: { publicToken, active: true },
      select: {
        id: true,
        name: true,
        organizationId: true,
        branch: { select: { name: true, timeZone: true } },
        organization: { select: { name: true, timeZone: true } },
      },
    }),
  );
}

/** The branch tablet: employee number and PIN; wrong number or PIN look the same. */
export async function clockAtTerminal(
  publicToken: string,
  rawInput: unknown,
  clientIp: string,
): Promise<ClockResult> {
  const terminal = await terminalInfo(publicToken);
  if (!terminal) return { ok: false, error: "INVALID" };
  const limit = await consumeRateLimit(`clock:${terminal.id}:${clientIp}`, { window: 60, max: 30 });
  if (!limit.allowed) return { ok: false, error: "RATE_LIMITED" };
  const parsed = terminalClockSchema.safeParse(rawInput);
  if (!parsed.success || !PIN_PATTERN.test(parsed.data.pin)) return { ok: false, error: "INVALID" };
  const { employeeNumber, pin } = parsed.data;
  const org = terminal.organizationId;
  const branchId = (
    await withTenantTx(org, (tx) =>
      tx.attendanceTerminal.findUniqueOrThrow({
        where: { id: terminal.id },
        select: { branchId: true },
      }),
    )
  ).branchId;
  const e = await withTenantTx(org, (tx) =>
    tx.employee.findFirst({ where: { organizationId: org, number: employeeNumber } }),
  );
  if (!e?.pinHash) return { ok: false, error: "INVALID" };
  if (e.pinLockedUntil && e.pinLockedUntil > new Date()) return { ok: false, error: "LOCKED" };
  if (!(await pinMatches(pin, e.pinHash))) {
    const failures = e.pinFailures + 1;
    await withTenantTx(org, (tx) =>
      tx.employee.update({
        where: { id: e.id },
        data:
          failures >= PIN_MAX_FAILURES
            ? { pinFailures: 0, pinLockedUntil: new Date(Date.now() + PIN_LOCK_MINUTES * 60_000) }
            : { pinFailures: failures },
      }),
    );
    return { ok: false, error: failures >= PIN_MAX_FAILURES ? "LOCKED" : "INVALID" };
  }
  if (e.status !== "ACTIVE") return { ok: false, error: "NOT_ACTIVE" };
  return withTenantTx(org, async (tx) => {
    await lockEmployee(tx, org, e.id);
    const kind = nextKind(await lastKind(tx, org, e.id));
    const at = new Date();
    await tx.attendancePunch.create({
      data: {
        organizationId: org,
        employeeId: e.id,
        branchId,
        kind,
        at,
        source: "TERMINAL",
        terminalId: terminal.id,
      },
    });
    if (e.pinFailures > 0)
      await tx.employee.update({ where: { id: e.id }, data: { pinFailures: 0 } });
    return { ok: true as const, firstName: e.firstName, kind, at };
  });
}

const phoneSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
});

/** The signed-in employee clocks in or out from their phone. */
export async function clockFromPhone(ctx: TenantContext, rawInput: unknown) {
  const parsed = phoneSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await tx.employee.findFirst({
      where: { organizationId: ctx.organizationId, userId: ctx.userId },
      include: { branch: { select: { geofence: true } } },
    });
    if (!e)
      throw businessRuleViolation(
        "ATTENDANCE_NOT_EMPLOYEE",
        "Your account is not linked to an employee",
      );
    if (e.status !== "ACTIVE")
      throw businessRuleViolation("ATTENDANCE_NOT_ACTIVE", "Only active employees clock in");
    const fence = e.branch.geofence;
    let distance: number | null = null;
    if (fence) {
      if (v.latitude === undefined || v.longitude === undefined)
        throw businessRuleViolation(
          "ATTENDANCE_LOCATION_NEEDED",
          "Allow location to clock in from your phone",
        );
      distance = distanceMeters(
        { latitude: v.latitude, longitude: v.longitude },
        { latitude: Number(fence.latitude), longitude: Number(fence.longitude) },
      );
      if (distance > fence.radiusMeters)
        throw businessRuleViolation(
          "ATTENDANCE_TOO_FAR",
          "You are too far from your branch to clock in",
          {
            distance: String(distance),
          },
        );
    }
    await lockEmployee(tx, ctx.organizationId, e.id);
    const kind = nextKind(await lastKind(tx, ctx.organizationId, e.id));
    const at = new Date();
    await tx.attendancePunch.create({
      data: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        branchId: e.branchId,
        kind,
        at,
        source: "PHONE",
        distanceMeters: distance,
      },
    });
    return { kind, at };
  });
}

/** The signed-in employee's own attendance: last punch, whether location is needed, this week. */
export async function myAttendance(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await tx.employee.findFirst({
      where: { organizationId: ctx.organizationId, userId: ctx.userId },
      include: {
        branch: {
          select: { name: true, timeZone: true, geofence: { select: { radiusMeters: true } } },
        },
      },
    });
    if (!e) return null;
    const tz = e.branch.timeZone ?? ctx.timeZone;
    const since = zonedInstant(addDays(businessDate(tz), -6), "00:00", tz);
    const punches = await tx.attendancePunch.findMany({
      where: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        voidedAt: null,
        at: { gte: since },
      },
      orderBy: { at: "asc" },
      select: { kind: true, at: true, source: true },
    });
    return {
      employee: {
        firstName: e.firstName,
        lastName: e.lastName,
        status: e.status,
        branch: e.branch.name,
      },
      timeZone: tz,
      needsLocation: Boolean(e.branch.geofence),
      clockedIn: (await lastKind(tx, ctx.organizationId, e.id)) === "IN",
      days: timesheet(punches, tz, new Date()).reverse(),
    };
  });
}

// ─── Devices ───

const deviceSchema = z.object({ name: requiredText(120), branchId: uuidSchema });

/** A fingerprint or face device posting punches to a signed endpoint; the secret is shown once. */
export async function createAttendanceDevice(ctx: TenantContext, rawInput: unknown) {
  const parsed = deviceSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  if (!canManageBranch(ctx, v.branchId)) throw forbidden();
  const secret = newSecret();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const b = await loadBranch(tx, ctx, v.branchId);
    const c = await tx.connector.create({
      data: {
        organizationId: ctx.organizationId,
        kind: "ATTENDANCE_DEVICE",
        name: v.name,
        config: { branchId: b.id },
        publicId: randomBytes(24).toString("base64url"),
        secretSealed: encryptSecret(secret, deviceKey()),
        secretHint: `…${secret.slice(-4)}`,
        createdByUserId: ctx.userId,
      },
      select: { id: true, publicId: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "connector.created",
      entityType: "connector",
      entityId: c.id,
      changes: { kind: "ATTENDANCE_DEVICE", name: v.name, branchId: b.id },
    });
    return { ...c, secret };
  });
}

const inboundSchema = z.object({
  punches: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(100),
        employeeNumber: z.string().trim().min(1).max(30),
        at: z.iso.datetime({ offset: true }),
        kind: z.enum(["IN", "OUT"]).optional(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * POST /api/integrations/inbound/<publicId> for an attendance device. Each
 * punch carries the device's own id; repeats are ignored, unknown employee
 * numbers are reported back. Without a kind, a punch alternates with the
 * employee's previous one.
 */
export async function handleAttendanceInbound(input: InboundInput): Promise<InboundResult> {
  const v = await verifyInbound(input, "ATTENDANCE_DEVICE");
  if (!v.ok) return v.result;
  const { connector, ctx, log } = v;
  let body: z.infer<typeof inboundSchema>;
  try {
    const parsed = inboundSchema.safeParse(JSON.parse(input.body));
    if (!parsed.success) throw new Error("format");
    body = parsed.data;
  } catch {
    await log("REJECTED", { error: "invalidBody" });
    return { status: 400, body: { error: "invalidBody" } };
  }
  const branchId = (connector.config as { branchId: string }).branchId;
  if (!canManageBranch(ctx, branchId)) {
    await log("REJECTED", { error: "creatorNoAccess" });
    return { status: 403, body: { error: "creatorNoAccess" } };
  }
  const org = connector.organizationId;
  const outcome = await withTenantTx(org, async (tx) => {
    let accepted = 0;
    let duplicates = 0;
    const unknown: string[] = [];
    for (const p of [...body.punches].sort((a, b) => a.at.localeCompare(b.at))) {
      const e = await tx.employee.findFirst({
        where: { organizationId: org, number: p.employeeNumber.toUpperCase() },
        select: { id: true },
      });
      if (!e) {
        unknown.push(p.employeeNumber);
        continue;
      }
      const seen = await tx.attendancePunch.findFirst({
        where: { connectorId: connector.id, externalId: p.id },
        select: { id: true },
      });
      if (seen) {
        duplicates += 1;
        continue;
      }
      await lockEmployee(tx, org, e.id);
      const at = new Date(p.at);
      await tx.attendancePunch.create({
        data: {
          organizationId: org,
          employeeId: e.id,
          branchId,
          kind: p.kind ?? nextKind(await lastKind(tx, org, e.id, at)),
          at,
          source: "DEVICE",
          connectorId: connector.id,
          externalId: p.id,
        },
      });
      accepted += 1;
    }
    return { accepted, duplicates, unknown };
  });
  try {
    await log("ACCEPTED", outcome);
  } catch {
    return { status: 200, body: { duplicate: true, ...outcome } };
  }
  return { status: 200, body: outcome };
}

// ─── HR: manual punches, voids, board ───

const manualSchema = z.object({
  kind: z.enum(["IN", "OUT"], { error: "invalidOption" }),
  date: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "invalid" }),
  reason: requiredText(300),
});

export async function addManualPunch(ctx: TenantContext, employeeId: string, rawInput: unknown) {
  const parsed = manualSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployeeFor(tx, ctx, employeeId, true);
    const branch = await tx.branch.findUniqueOrThrow({
      where: { id: e.branchId },
      select: { timeZone: true },
    });
    const at = zonedInstant(v.date, v.time, branch.timeZone ?? ctx.timeZone);
    if (at > new Date())
      throw businessRuleViolation("ATTENDANCE_IN_FUTURE", "A punch cannot be in the future", {
        field: "time",
      });
    const p = await tx.attendancePunch.create({
      data: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        branchId: e.branchId,
        kind: v.kind,
        at,
        source: "MANUAL",
        recordedByUserId: ctx.userId,
        reason: v.reason,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "attendance.manual_punch",
      entityType: "employee",
      entityId: e.id,
      changes: { kind: v.kind, at: at.toISOString(), reason: v.reason },
    });
    return p;
  });
}

export async function voidPunch(ctx: TenantContext, punchId: string, rawInput: unknown) {
  const id = uuidSchema.safeParse(punchId);
  if (!id.success) throw notFound("Punch");
  const parsed = z.object({ reason: requiredText(300) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const p = await tx.attendancePunch.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data, voidedAt: null },
    });
    if (!p) throw notFound("Punch");
    await loadEmployeeFor(tx, ctx, p.employeeId, true);
    await tx.attendancePunch.update({
      where: { id: p.id },
      data: { voidedAt: new Date(), voidedByUserId: ctx.userId, voidReason: parsed.data.reason },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "attendance.punch_voided",
      entityType: "employee",
      entityId: p.employeeId,
      changes: { kind: p.kind, at: p.at.toISOString(), reason: parsed.data.reason },
    });
    return { employeeId: p.employeeId };
  });
}

/** One day for the employees the user may see: who is in now, hours and issues. */
export async function attendanceBoard(ctx: TenantContext, rawDay?: unknown) {
  if (!canViewHr(ctx)) throw forbidden();
  const today = businessDate(ctx.timeZone);
  const day = z
    .string()
    .refine(isCalendarDate)
    .catch(today)
    .parse(rawDay ?? today);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const employees = await tx.employee.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { not: "TERMINATED" },
        AND: [viewBranches(ctx)],
      },
      select: {
        id: true,
        number: true,
        firstName: true,
        lastName: true,
        status: true,
        branch: { select: { code: true, timeZone: true } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    });
    // A window wide enough for night shifts and any time zone.
    const from = zonedInstant(addDays(day, -1), "00:00", "UTC");
    const to = zonedInstant(addDays(day, 2), "00:00", "UTC");
    const punches = await tx.attendancePunch.findMany({
      where: {
        organizationId: ctx.organizationId,
        employeeId: { in: employees.map((e) => e.id) },
        voidedAt: null,
        at: { gte: from, lt: to },
      },
      orderBy: { at: "asc" },
      select: { employeeId: true, kind: true, at: true, source: true },
    });
    const now = new Date();
    const rows = employees.map((e) => {
      const tz = e.branch.timeZone ?? ctx.timeZone;
      const mine = punches.filter((p) => p.employeeId === e.id);
      const sheet = timesheet(mine, tz, now).find((d) => d.day === day) ?? null;
      const last = mine.filter((p) => p.at <= now).at(-1) ?? null;
      return {
        employee: e,
        timeZone: tz,
        inNow: day === today && last?.kind === "IN" && localDay(last.at, tz) >= addDays(day, -1),
        sheet,
        sources: [...new Set(mine.filter((p) => localDay(p.at, tz) === day).map((p) => p.source))],
      };
    });
    return { day, today, rows };
  });
}

/** An employee's punches for the last 14 days, voided ones included (for HR). */
export async function employeePunches(ctx: TenantContext, employeeId: string) {
  if (!canViewHr(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployeeFor(tx, ctx, employeeId, false);
    const punches = await tx.attendancePunch.findMany({
      where: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        at: { gte: new Date(Date.now() - 14 * 86_400_000) },
      },
      orderBy: { at: "desc" },
      include: { terminal: { select: { name: true } }, connector: { select: { name: true } } },
    });
    const tz =
      (await tx.branch.findUniqueOrThrow({ where: { id: e.branchId }, select: { timeZone: true } }))
        .timeZone ?? ctx.timeZone;
    return {
      timeZone: tz,
      punches,
      days: timesheet(
        punches.filter((p) => !p.voidedAt),
        tz,
        new Date(),
      ).reverse(),
      hasPin: Boolean(e.pinHash),
      can: { manage: canManageBranch(ctx, e.branchId) },
    };
  });
}

/** Setup: tablets, devices and branch locations for the branches the user manages. */
export async function attendanceSetup(ctx: TenantContext) {
  if (!holdsAnyGrant(ctx.grants, "hr.manage")) throw forbidden();
  const scope = accessibleScope(ctx.grants, "hr.manage");
  const branchWhere = scope.all ? {} : { id: { in: scope.branchIds } };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branches = await tx.branch.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null, ...branchWhere },
      select: {
        id: true,
        code: true,
        name: true,
        geofence: true,
        attendanceTerminals: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { code: "asc" },
    });
    const devices = await tx.connector.findMany({
      where: { organizationId: ctx.organizationId, kind: "ATTENDANCE_DEVICE" },
      select: {
        id: true,
        name: true,
        publicId: true,
        secretHint: true,
        status: true,
        config: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const ids = new Set(branches.map((b) => b.id));
    return {
      branches,
      devices: devices.filter((d) => ids.has((d.config as { branchId: string }).branchId)),
    };
  });
}

/** Whether the signed-in user is linked to an employee record (for the "My attendance" link). */
export async function hasEmployeeRecord(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) =>
    Boolean(
      await tx.employee.findFirst({
        where: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          status: { not: "TERMINATED" },
        },
        select: { id: true },
      }),
    ),
  );
}
