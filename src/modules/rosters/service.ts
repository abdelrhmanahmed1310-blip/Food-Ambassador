import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString } from "@/lib/decimal";
import { accessibleScope, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { timesheet } from "@/modules/hr/attendance-rules";
import { canViewHr } from "@/modules/hr/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { codeSchema, optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import { roundToCurrency } from "@/modules/tax/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import {
  assignSessions,
  basisDaysFor,
  compareShift,
  hourlyRate,
  paidMinutes,
  shiftWindow,
  TIME_PATTERN,
  weekDays,
  weekStart,
  type SessionInput,
  type ShiftComparison,
} from "./rules";

/**
 * Rosters (DECISIONS.md ADR-128): planned shifts per person, branch and
 * day, compared with the clock-ins of ADR-080 for lateness, leaving early,
 * no-shows and overtime. Managers decide on overtime; approved overtime is
 * paid through payroll (ADR-123). Branch managers roster their branch with
 * `rosters.manage`; pay figures need `payroll.view`.
 */

const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? "0");
const date = z.string().refine(isCalendarDate, { error: "invalidDate" });
const time = z
  .string()
  .trim()
  .refine((v) => TIME_PATTERN.test(v), { error: "invalidTime" });
const minutes = (max: number) => z.coerce.number({ error: "invalidNumber" }).int().min(0).max(max);

const canManageBranch = (ctx: TenantContext, branchId: string) =>
  hasPermission(ctx.grants, "rosters.manage", { branchId });
const managesAll = (ctx: TenantContext) => accessibleScope(ctx.grants, "hr.manage").all;

function viewBranchIds(ctx: TenantContext): string[] | null {
  const v = accessibleScope(ctx.grants, "hr.view");
  const m = accessibleScope(ctx.grants, "hr.manage");
  const r = accessibleScope(ctx.grants, "rosters.manage");
  if (v.all || m.all || r.all) return null;
  return [...new Set([...v.branchIds, ...m.branchIds, ...r.branchIds])];
}

// ─── Settings ───

export async function getRosterSettings(ctx: TenantContext) {
  if (!canViewHr(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.rosterSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
  );
}

const settingsSchema = z
  .object({
    graceMinutes: minutes(120),
    overtimeMinimumMinutes: minutes(240),
    standardDailyHours: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || null)
      .pipe(decimalString({ maxScale: 2, min: "0.5", max: "24" }).nullable()),
    overtimeMultiplier: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || null)
      .pipe(decimalString({ maxScale: 4, min: "1", max: "10" }).nullable()),
    overtimeBase: z
      .enum(["BASIC", "GROSS", ""], { error: "invalidOption" })
      .optional()
      .transform((v) => v || null),
  })
  .refine((s) => !s.overtimeMultiplier === !s.overtimeBase, {
    error: "overtimePayIncomplete",
    path: ["overtimeBase"],
  });

/** Grace, overtime minimum and overtime pay, as the organization enters them (nothing preset). */
export async function setRosterSettings(ctx: TenantContext, rawInput: unknown) {
  if (!managesAll(ctx)) throw forbidden();
  const parsed = settingsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const data = { ...v, updatedByUserId: ctx.userId };
    await tx.rosterSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ...data },
      update: data,
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "roster.settings_changed",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: v,
    });
  });
}

// ─── Shift templates ───

export async function listShiftTemplates(ctx: TenantContext, includeArchived = false) {
  if (!canViewHr(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.shiftTemplate.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ startTime: "asc" }, { code: "asc" }],
    }),
  );
}

const templateSchema = z
  .object({
    code: codeSchema,
    name: requiredText(80),
    startTime: time,
    endTime: time,
    breakMinutes: minutes(240),
  })
  .refine((t) => t.startTime !== t.endTime, { error: "shiftTooLong", path: ["endTime"] });

export async function createShiftTemplate(ctx: TenantContext, rawInput: unknown) {
  if (!managesAll(ctx)) throw forbidden();
  const parsed = templateSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const clash = await tx.shiftTemplate.findFirst({
      where: { organizationId: ctx.organizationId, code: v.code },
      select: { id: true },
    });
    if (clash) throw conflict("A shift with this code already exists", { field: "code" });
    const length = paidMinutes(...windowOf("2026-01-05", v.startTime, v.endTime), 0);
    if (v.breakMinutes >= length)
      throw businessRuleViolation("SHIFT_BREAK_TOO_LONG", "The break is as long as the shift", {
        field: "breakMinutes",
      });
    const t = await tx.shiftTemplate.create({
      data: { organizationId: ctx.organizationId, ...v },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "shift_template.created",
      entityType: "shift_template",
      entityId: t.id,
      changes: v,
    });
    return t;
  });
}

export async function setShiftTemplateArchived(
  ctx: TenantContext,
  templateId: string,
  archived: boolean,
) {
  if (!managesAll(ctx)) throw forbidden();
  const id = uuidSchema.safeParse(templateId);
  if (!id.success) throw notFound("Shift");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await tx.shiftTemplate.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data },
    });
    if (!t) throw notFound("Shift");
    await tx.shiftTemplate.update({
      where: { id: t.id },
      data: { archivedAt: archived ? new Date() : null },
    });
  });
}

const windowOf = (day: string, start: string, end: string): [Date, Date] => {
  const w = shiftWindow(day, start, end, "UTC");
  return [w.startsAt, w.endsAt];
};

// ─── Shifts ───

async function branchTz(tx: Tx, ctx: TenantContext, branchId: string) {
  const id = uuidSchema.safeParse(branchId);
  if (!id.success) throw notFound("Branch");
  const b = await tx.branch.findFirst({
    where: { organizationId: ctx.organizationId, id: id.data, archivedAt: null },
    select: { id: true, code: true, name: true, timeZone: true },
  });
  if (!b) throw notFound("Branch");
  return { ...b, tz: b.timeZone ?? ctx.timeZone };
}

/** Approved leave covering a day, if any. */
async function leaveOn(tx: Tx, ctx: TenantContext, employeeId: string, day: string) {
  return tx.leaveRequest.findFirst({
    where: {
      organizationId: ctx.organizationId,
      employeeId,
      status: "APPROVED",
      startDate: { lte: asDate(day) },
      endDate: { gte: asDate(day) },
    },
    select: { id: true },
  });
}

interface PlannedShift {
  employeeId: string;
  branchId: string;
  day: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  templateId: string | null;
  note: string | null;
}

/** Check a planned shift and create it as a draft: no overlap, not on leave, while employed. */
async function createShiftInTx(tx: Tx, ctx: TenantContext, tz: string, s: PlannedShift) {
  const employee = await tx.employee.findFirst({
    where: { organizationId: ctx.organizationId, id: s.employeeId },
    select: { id: true, branchId: true, hireDate: true, terminatedOn: true, status: true },
  });
  if (!employee) throw notFound("Employee");
  const ids = viewBranchIds(ctx);
  if (ids && !ids.includes(employee.branchId) && employee.branchId !== s.branchId)
    throw notFound("Employee");
  if (
    s.day < iso(employee.hireDate) ||
    (employee.terminatedOn && s.day > iso(employee.terminatedOn))
  )
    throw businessRuleViolation("SHIFT_NOT_EMPLOYED", "The employee is not employed on this day", {
      field: "day",
    });
  const { startsAt, endsAt } = shiftWindow(s.day, s.startTime, s.endTime, tz);
  if (s.breakMinutes >= paidMinutes(startsAt, endsAt, 0))
    throw businessRuleViolation("SHIFT_BREAK_TOO_LONG", "The break is as long as the shift", {
      field: "breakMinutes",
    });
  // One change at a time per person, so two managers cannot double-book them.
  await tx.$queryRaw`SELECT 1 FROM "employees" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${employee.id}::uuid FOR UPDATE`;
  const clash = await tx.rosterShift.findFirst({
    where: {
      organizationId: ctx.organizationId,
      employeeId: employee.id,
      cancelledAt: null,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: { id: true },
  });
  if (clash)
    throw businessRuleViolation("SHIFT_OVERLAP", "This person already has a shift at this time", {
      field: "startTime",
    });
  if (await leaveOn(tx, ctx, employee.id, s.day))
    throw businessRuleViolation("SHIFT_ON_LEAVE", "This person is on approved leave that day", {
      field: "day",
    });
  return tx.rosterShift.create({
    data: {
      organizationId: ctx.organizationId,
      employeeId: employee.id,
      branchId: s.branchId,
      day: asDate(s.day),
      startTime: s.startTime,
      endTime: s.endTime,
      breakMinutes: s.breakMinutes,
      startsAt,
      endsAt,
      templateId: s.templateId,
      note: s.note,
      createdByUserId: ctx.userId,
    },
  });
}

const shiftSchema = z
  .object({
    employeeId: uuidSchema,
    branchId: uuidSchema,
    day: date,
    templateId: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || null)
      .pipe(uuidSchema.nullable()),
    startTime: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || null),
    endTime: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || null),
    breakMinutes: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || null),
    note: optionalText(200),
  })
  .superRefine((s, c) => {
    if (s.templateId) return;
    for (const k of ["startTime", "endTime"] as const)
      if (!s[k] || !TIME_PATTERN.test(s[k]))
        c.addIssue({ code: "custom", path: [k], message: "invalidTime" });
    if (s.startTime && s.startTime === s.endTime)
      c.addIssue({ code: "custom", path: ["endTime"], message: "shiftTooLong" });
    const b = Number(s.breakMinutes ?? "0");
    if (!Number.isInteger(b) || b < 0 || b > 240)
      c.addIssue({ code: "custom", path: ["breakMinutes"], message: "invalidNumber" });
  });

/** Add a draft shift: from a template, or with its own times. */
export async function addShift(ctx: TenantContext, rawInput: unknown) {
  const parsed = shiftSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  if (!canManageBranch(ctx, v.branchId)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await branchTz(tx, ctx, v.branchId);
    let planned = {
      startTime: v.startTime ?? "",
      endTime: v.endTime ?? "",
      breakMinutes: Number(v.breakMinutes ?? "0"),
    };
    if (v.templateId) {
      const t = await tx.shiftTemplate.findFirst({
        where: { organizationId: ctx.organizationId, id: v.templateId, archivedAt: null },
      });
      if (!t) throw notFound("Shift");
      planned = { startTime: t.startTime, endTime: t.endTime, breakMinutes: t.breakMinutes };
    }
    const s = await createShiftInTx(tx, ctx, branch.tz, {
      employeeId: v.employeeId,
      branchId: branch.id,
      day: v.day,
      ...planned,
      templateId: v.templateId,
      note: v.note ?? null,
    });
    return { id: s.id };
  });
}

async function loadShift(tx: Tx, ctx: TenantContext, shiftId: string) {
  const id = uuidSchema.safeParse(shiftId);
  if (!id.success) throw notFound("Shift");
  const s = await tx.rosterShift.findFirst({
    where: { organizationId: ctx.organizationId, id: id.data },
  });
  if (!s) throw notFound("Shift");
  return s;
}

/** Drafts are removed; published shifts are cancelled with a reason. */
export async function removeShift(ctx: TenantContext, shiftId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShift(tx, ctx, shiftId);
    if (!canManageBranch(ctx, s.branchId)) throw forbidden();
    if (s.publishedAt)
      throw businessRuleViolation("SHIFT_PUBLISHED", "A published shift is cancelled, not removed");
    await tx.rosterShift.delete({ where: { id: s.id } });
  });
}

export async function cancelShift(ctx: TenantContext, shiftId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(200) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShift(tx, ctx, shiftId);
    if (!canManageBranch(ctx, s.branchId)) throw forbidden();
    if (!s.publishedAt || s.cancelledAt)
      throw businessRuleViolation("SHIFT_NOT_PUBLISHED", "Only a published shift is cancelled");
    const decided = await tx.overtimeDecision.findUnique({
      where: { organizationId_shiftId: { organizationId: ctx.organizationId, shiftId: s.id } },
      select: { id: true },
    });
    if (decided)
      throw businessRuleViolation("SHIFT_HAS_OVERTIME", "Overtime was decided on this shift");
    await tx.rosterShift.update({
      where: { id: s.id },
      data: {
        cancelledAt: new Date(),
        cancelledByUserId: ctx.userId,
        cancelReason: parsed.data.reason,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "roster_shift.cancelled",
      entityType: "employee",
      entityId: s.employeeId,
      changes: { day: iso(s.day), start: s.startTime, reason: parsed.data.reason },
    });
    return { day: iso(s.day), branchId: s.branchId };
  });
}

const weekSchema = z.object({ branchId: uuidSchema, week: date });

/** Publish a branch's draft shifts for a week: staff then see them. */
export async function publishWeek(ctx: TenantContext, rawInput: unknown) {
  const parsed = weekSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { branchId } = parsed.data;
  const monday = weekStart(parsed.data.week);
  if (!canManageBranch(ctx, branchId)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    await branchTz(tx, ctx, branchId);
    const { count } = await tx.rosterShift.updateMany({
      where: {
        organizationId: ctx.organizationId,
        branchId,
        publishedAt: null,
        day: { gte: asDate(monday), lte: asDate(addDays(monday, 6)) },
      },
      data: { publishedAt: new Date(), publishedByUserId: ctx.userId },
    });
    if (count === 0)
      throw businessRuleViolation(
        "ROSTER_NOTHING_TO_PUBLISH",
        "There are no draft shifts this week",
      );
    await recordAudit(tx, actorOf(ctx), {
      action: "roster.published",
      entityType: "branch",
      entityId: branchId,
      changes: { week: monday, shifts: count },
    });
    return { count };
  });
}

/** Copy a week's shifts (not cancelled ones) into another week as drafts; clashes are skipped. */
export async function copyWeek(ctx: TenantContext, rawInput: unknown) {
  const parsed = weekSchema.extend({ fromWeek: date }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { branchId } = parsed.data;
  const to = weekStart(parsed.data.week);
  const from = weekStart(parsed.data.fromWeek);
  if (from === to)
    throw businessRuleViolation("ROSTER_SAME_WEEK", "Choose a different week to copy from");
  if (!canManageBranch(ctx, branchId)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await branchTz(tx, ctx, branchId);
    const source = await tx.rosterShift.findMany({
      where: {
        organizationId: ctx.organizationId,
        branchId,
        cancelledAt: null,
        day: { gte: asDate(from), lte: asDate(addDays(from, 6)) },
      },
      orderBy: { startsAt: "asc" },
    });
    const offset = Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86_400_000);
    let copied = 0;
    let skipped = 0;
    for (const s of source) {
      const day = addDays(iso(s.day), offset);
      if (!(await shiftFits(tx, ctx, branch.tz, s, day))) {
        skipped++;
        continue;
      }
      await createShiftInTx(tx, ctx, branch.tz, {
        employeeId: s.employeeId,
        branchId,
        day,
        startTime: s.startTime,
        endTime: s.endTime,
        breakMinutes: s.breakMinutes,
        templateId: s.templateId,
        note: s.note,
      });
      copied++;
    }
    return { copied, skipped };
  });
}

/** Whether a copied shift would pass the checks of createShiftInTx (checked first, so nothing throws mid-transaction). */
async function shiftFits(
  tx: Tx,
  ctx: TenantContext,
  tz: string,
  s: { employeeId: string; startTime: string; endTime: string },
  day: string,
) {
  const e = await tx.employee.findFirst({
    where: { organizationId: ctx.organizationId, id: s.employeeId },
    select: { hireDate: true, terminatedOn: true },
  });
  if (!e || day < iso(e.hireDate) || (e.terminatedOn && day > iso(e.terminatedOn))) return false;
  const { startsAt, endsAt } = shiftWindow(day, s.startTime, s.endTime, tz);
  const clash = await tx.rosterShift.findFirst({
    where: {
      organizationId: ctx.organizationId,
      employeeId: s.employeeId,
      cancelledAt: null,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: { id: true },
  });
  if (clash) return false;
  return !(await leaveOn(tx, ctx, s.employeeId, day));
}

// ─── Comparing with clock-ins ───

type ShiftRow = Awaited<ReturnType<Tx["rosterShift"]["findMany"]>>[number];
export type ShiftView = ShiftRow & {
  comparison: (ShiftComparison & { onLeave: boolean }) | null;
  overtime: { status: string; minutes: number; paid: boolean } | null;
};

/**
 * Compare published shifts with each person's sessions: sessions come from
 * the timesheet of ADR-080 in the branch's time, and each goes to one
 * shift. A no-show on approved leave is shown as leave.
 */
async function compareInTx(
  tx: Tx,
  ctx: TenantContext,
  shifts: ShiftRow[],
  tzOf: (s: ShiftRow) => string,
) {
  const out = new Map<string, ShiftView["comparison"]>();
  const live = shifts.filter((s) => s.publishedAt && !s.cancelledAt);
  if (live.length === 0) return out;
  const settings = await tx.rosterSettings.findUnique({
    where: { organizationId: ctx.organizationId },
  });
  const grace = settings?.graceMinutes ?? 0;
  const minimum = settings?.overtimeMinimumMinutes ?? 0;
  const from = new Date(Math.min(...live.map((s) => s.startsAt.getTime())) - 86_400_000);
  const to = new Date(Math.max(...live.map((s) => s.endsAt.getTime())) + 86_400_000);
  const employeeIds = [...new Set(live.map((s) => s.employeeId))];
  const [punches, leave] = await Promise.all([
    tx.attendancePunch.findMany({
      where: {
        organizationId: ctx.organizationId,
        employeeId: { in: employeeIds },
        voidedAt: null,
        at: { gte: from, lt: to },
      },
      orderBy: { at: "asc" },
      select: { employeeId: true, kind: true, at: true },
    }),
    tx.leaveRequest.findMany({
      where: {
        organizationId: ctx.organizationId,
        employeeId: { in: employeeIds },
        status: "APPROVED",
        startDate: { lte: to },
        endDate: { gte: from },
      },
      select: { employeeId: true, startDate: true, endDate: true },
    }),
  ]);
  const now = new Date();
  for (const employeeId of employeeIds) {
    const mine = live.filter((s) => s.employeeId === employeeId);
    const tz = tzOf(mine[0]);
    const sessions: SessionInput[] = timesheet(
      punches.filter((p) => p.employeeId === employeeId),
      tz,
      now,
    ).flatMap((d) => d.sessions);
    const assigned = assignSessions(mine, sessions);
    mine.forEach((s, k) => {
      const c = compareShift({
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        breakMinutes: s.breakMinutes,
        sessions: assigned[k].map((i) => sessions[i]),
        now,
        graceMinutes: grace,
        overtimeMinimumMinutes: minimum,
      });
      const onLeave = leave.some(
        (l) => l.employeeId === employeeId && l.startDate <= s.day && l.endDate >= s.day,
      );
      out.set(s.id, { ...c, onLeave: onLeave && c.outcome === "NO_SHOW" });
    });
  }
  return out;
}

/** Hourly rates on a day, for the people the user may see pay of. */
async function ratesInTx(tx: Tx, ctx: TenantContext, employeeIds: string[]) {
  const [settings, payroll] = await Promise.all([
    tx.rosterSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
    tx.payrollSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
  ]);
  if (!settings?.standardDailyHours || !payroll) return null;
  const salaries = await tx.employeeSalary.findMany({
    where: { organizationId: ctx.organizationId, employeeId: { in: employeeIds } },
    orderBy: { effectiveFrom: "desc" },
    include: { items: true },
  });
  const hours = dec(settings.standardDailyHours);
  return (employeeId: string, day: string) => {
    const s = salaries.find((x) => x.employeeId === employeeId && iso(x.effectiveFrom) <= day);
    if (!s) return null;
    const monthly = s.items.reduce((a, i) => a.plus(dec(i.amount)), dec(s.basic));
    return hourlyRate(monthly, basisDaysFor(payroll.prorationBasis, day), hours);
  };
}

/**
 * A branch's week: who works when, how it compares with the clock-ins,
 * and — for those who may see pay — planned and worked labour cost at
 * straight time (gross monthly pay as an hourly rate; employer
 * contributions and overtime premiums not included).
 */
export async function rosterWeek(ctx: TenantContext, raw: { branchId?: unknown; week?: unknown }) {
  if (!canViewHr(ctx)) throw forbidden();
  const ids = viewBranchIds(ctx);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branches = await tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(ids ? { id: { in: ids } } : {}),
      },
      select: {
        id: true,
        code: true,
        name: true,
        timeZone: true,
        company: { select: { currency: true } },
      },
      orderBy: { code: "asc" },
    });
    const requested = uuidSchema.safeParse(raw.branchId);
    const branch =
      branches.find((b) => requested.success && b.id === requested.data) ?? branches[0] ?? null;
    if (!branch) return null;
    const tz = branch.timeZone ?? ctx.timeZone;
    const today = businessDate(tz);
    const wk = date.safeParse(raw.week);
    const monday = weekStart(wk.success ? wk.data : today);
    const days = weekDays(monday);
    const shifts = await tx.rosterShift.findMany({
      where: {
        organizationId: ctx.organizationId,
        branchId: branch.id,
        day: { gte: asDate(monday), lte: asDate(days[6]) },
      },
      orderBy: { startsAt: "asc" },
      include: {
        overtime: { include: { adjustment: { select: { run: { select: { status: true } } } } } },
      },
    });
    const employees = await tx.employee.findMany({
      where: {
        organizationId: ctx.organizationId,
        OR: [
          { branchId: branch.id, status: { not: "TERMINATED" } },
          { id: { in: shifts.map((s) => s.employeeId) } },
        ],
      },
      select: {
        id: true,
        number: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        branchId: true,
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    });
    const comparisons = await compareInTx(tx, ctx, shifts, () => tz);
    const rate = hasPermission(ctx.grants, "payroll.view")
      ? await ratesInTx(
          tx,
          ctx,
          employees.map((e) => e.id),
        )
      : null;
    let plannedMinutes = 0;
    let workedMinutes = 0;
    let overtimeMinutes = 0;
    let plannedCost = new Decimal(0);
    let workedCost = new Decimal(0);
    let uncosted = 0;
    const views: ShiftView[] = shifts.map((s) => {
      const c = comparisons.get(s.id) ?? null;
      const { overtime, ...rest } = s;
      if (!s.cancelledAt) {
        const planned = paidMinutes(s.startsAt, s.endsAt, s.breakMinutes);
        plannedMinutes += planned;
        workedMinutes += c?.workedMinutes ?? 0;
        overtimeMinutes += c?.overtimeMinutes ?? 0;
        const r = rate?.(s.employeeId, iso(s.day));
        if (rate && !r) uncosted++;
        if (r) {
          plannedCost = plannedCost.plus(r.times(planned).dividedBy(60));
          workedCost = workedCost.plus(r.times(c?.workedMinutes ?? 0).dividedBy(60));
        }
      }
      return {
        ...rest,
        comparison: c,
        overtime: overtime
          ? {
              status: overtime.status,
              minutes: overtime.minutes,
              paid: Boolean(overtime.adjustment && overtime.adjustment.run.status !== "CANCELLED"),
            }
          : null,
      };
    });
    const currency = branch.company.currency;
    const templates = await tx.shiftTemplate.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      orderBy: { startTime: "asc" },
    });
    return {
      branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name })),
      branch: { id: branch.id, code: branch.code, name: branch.name, timeZone: tz },
      week: monday,
      days,
      today,
      employees,
      shifts: views,
      templates,
      drafts: shifts.filter((s) => !s.publishedAt).length,
      totals: {
        plannedMinutes,
        workedMinutes,
        overtimeMinutes,
        cost: rate
          ? {
              currency,
              planned: roundToCurrency(plannedCost, currency).toFixed(),
              worked: roundToCurrency(workedCost, currency).toFixed(),
              uncosted,
            }
          : null,
      },
      can: { manage: canManageBranch(ctx, branch.id) },
    };
  });
}

/** One shift with its clock-in comparison and overtime decision. */
export async function getShift(ctx: TenantContext, shiftId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShift(tx, ctx, shiftId);
    const self = await tx.employee.findFirst({
      where: { organizationId: ctx.organizationId, id: s.employeeId },
      select: {
        id: true,
        number: true,
        firstName: true,
        lastName: true,
        userId: true,
        branchId: true,
      },
    });
    const ids = viewBranchIds(ctx);
    const viewer =
      canViewHr(ctx) && (!ids || ids.includes(s.branchId) || ids.includes(self!.branchId));
    const mine = self!.userId === ctx.userId && Boolean(s.publishedAt);
    if (!viewer && !mine) throw notFound("Shift");
    const branch = await branchTz(tx, ctx, s.branchId);
    const comparison = (await compareInTx(tx, ctx, [s], () => branch.tz)).get(s.id) ?? null;
    const overtime = await tx.overtimeDecision.findUnique({
      where: { organizationId_shiftId: { organizationId: ctx.organizationId, shiftId: s.id } },
      include: {
        adjustment: { select: { run: { select: { id: true, number: true, status: true } } } },
      },
    });
    const manage = canManageBranch(ctx, s.branchId);
    return {
      shift: s,
      employee: self!,
      branch,
      comparison,
      overtime,
      can: {
        manage,
        decideOvertime:
          manage &&
          self!.userId !== ctx.userId &&
          !overtime &&
          Boolean(comparison && comparison.overtimeMinutes > 0),
      },
    };
  });
}

const decisionSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"], { error: "invalidOption" }),
    minutes: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || null),
    note: optionalText(300),
  })
  .refine((d) => d.decision === "REJECT" || !d.minutes || /^\d{1,4}$/.test(d.minutes), {
    error: "invalidNumber",
    path: ["minutes"],
  });

/**
 * Approve (all or some of) or reject overtime the clock-ins showed on a
 * published shift. Not one's own; decided once.
 */
export async function decideOvertime(ctx: TenantContext, shiftId: string, rawInput: unknown) {
  const parsed = decisionSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShift(tx, ctx, shiftId);
    if (!canManageBranch(ctx, s.branchId)) throw forbidden();
    const e = await tx.employee.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, id: s.employeeId },
      select: { userId: true },
    });
    if (e.userId && e.userId === ctx.userId)
      throw businessRuleViolation("OVERTIME_SELF", "Someone else decides on your own overtime");
    const branch = await branchTz(tx, ctx, s.branchId);
    const c = (await compareInTx(tx, ctx, [s], () => branch.tz)).get(s.id);
    if (!c || c.overtimeMinutes <= 0)
      throw businessRuleViolation("OVERTIME_NONE", "The clock-ins show no overtime on this shift");
    const minutes = v.decision === "REJECT" ? 0 : v.minutes ? Number(v.minutes) : c.overtimeMinutes;
    if (v.decision === "APPROVE" && (minutes <= 0 || minutes > c.overtimeMinutes))
      throw businessRuleViolation(
        "OVERTIME_TOO_MANY",
        "Approve at most the overtime the clock-ins show",
        { field: "minutes" },
      );
    const existing = await tx.overtimeDecision.findUnique({
      where: { organizationId_shiftId: { organizationId: ctx.organizationId, shiftId: s.id } },
      select: { id: true },
    });
    if (existing) throw conflict("Overtime on this shift was already decided");
    const d = await tx.overtimeDecision.create({
      data: {
        organizationId: ctx.organizationId,
        shiftId: s.id,
        employeeId: s.employeeId,
        measuredMinutes: c.overtimeMinutes,
        minutes,
        status: v.decision === "APPROVE" ? "APPROVED" : "REJECTED",
        note: v.note,
        decidedByUserId: ctx.userId,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: v.decision === "APPROVE" ? "overtime.approved" : "overtime.rejected",
      entityType: "employee",
      entityId: s.employeeId,
      changes: { day: iso(s.day), measured: c.overtimeMinutes, minutes },
    });
    return d;
  });
}

/** The signed-in employee's published shifts: last week to two weeks ahead. */
export async function myRoster(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await tx.employee.findFirst({
      where: { organizationId: ctx.organizationId, userId: ctx.userId },
      select: { id: true, branch: { select: { timeZone: true } } },
    });
    if (!e) return null;
    const tz = e.branch.timeZone ?? ctx.timeZone;
    const today = businessDate(tz);
    const from = addDays(weekStart(today), -7);
    const shifts = await tx.rosterShift.findMany({
      where: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        publishedAt: { not: null },
        day: { gte: asDate(from), lte: asDate(addDays(weekStart(today), 20)) },
      },
      orderBy: { startsAt: "asc" },
      include: {
        branch: { select: { code: true, name: true, timeZone: true } },
        overtime: { select: { status: true, minutes: true } },
      },
    });
    const comparisons = await compareInTx(
      tx,
      ctx,
      shifts,
      (s) => (shifts.find((x) => x.id === s.id)?.branch.timeZone ?? tz) as string,
    );
    return {
      today,
      shifts: shifts.map((s) => ({ ...s, comparison: comparisons.get(s.id) ?? null })),
    };
  });
}

/** Overtime approved and not yet in a live payroll run (for payroll). */
export const unpaidOvertimeWhere = (organizationId: string): Prisma.OvertimeDecisionWhereInput => ({
  organizationId,
  status: "APPROVED",
  OR: [{ payrollAdjustmentId: null }, { adjustment: { run: { status: "CANCELLED" } } }],
});
