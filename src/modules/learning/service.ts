import "server-only";
import { z } from "zod";
import { toCsv } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { zonedInstant } from "@/modules/pos/pickup-rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import {
  complianceStatus,
  expiryFor,
  latestRecord,
  requirementApplies,
  TRAINING_CATEGORIES,
  TRAINING_DELIVERIES,
  TRAINING_SCOPES,
  type ComplianceStatus,
} from "./rules";

/**
 * Training and certification (DECISIONS.md ADR-125): a course catalogue,
 * who must hold which course, sessions at branches with attendance and
 * results, records with expiry (from sessions or outside providers), and
 * a compliance matrix. `training.view` / `training.manage`, per branch; the
 * catalogue and requirements need organization-wide `training.manage`.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const date = z.string().refine(isCalendarDate, { error: "invalidDate" });
const code = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .refine((v) => /^[A-Z][A-Z0-9_-]{0,19}$/.test(v), { error: "invalidCode" });
const optionalInt = (max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .refine((v) => v === undefined || (/^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= max), {
      error: "invalidNumber",
    })
    .transform((v) => (v === undefined ? null : Number(v)));

export const canViewTraining = (ctx: TenantContext) =>
  holdsAnyGrant(ctx.grants, "training.view") || holdsAnyGrant(ctx.grants, "training.manage");
const canManageCatalogue = (ctx: TenantContext) => hasPermission(ctx.grants, "training.manage");
const canManageAt = (ctx: TenantContext, branchId: string) =>
  hasPermission(ctx.grants, "training.manage", { branchId });
const canViewAt = (ctx: TenantContext, branchId: string) =>
  hasPermission(ctx.grants, "training.view", { branchId }) || canManageAt(ctx, branchId);

/** Branches the person may see training for; null means all. */
function viewBranches(ctx: TenantContext): string[] | null {
  const v = accessibleScope(ctx.grants, "training.view");
  const m = accessibleScope(ctx.grants, "training.manage");
  if (v.all || m.all) return null;
  return [...new Set([...v.branchIds, ...m.branchIds])];
}

// ─── Courses and requirements ───

const courseSchema = z.object({
  code,
  name: requiredText(120),
  nameAr: optionalText(120),
  category: z.enum(TRAINING_CATEGORIES, { error: "invalidOption" }),
  delivery: z.enum(TRAINING_DELIVERIES, { error: "invalidOption" }),
  validityMonths: optionalInt(120),
  description: optionalText(1000),
});

export async function createCourse(ctx: TenantContext, rawInput: unknown) {
  if (!canManageCatalogue(ctx)) throw forbidden();
  const parsed = courseSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const c = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    try {
      const course = await tx.trainingCourse.create({
        data: { organizationId: ctx.organizationId, ...c },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "training_course.created",
        entityType: "training_course",
        entityId: course.id,
        changes: { code: c.code, validityMonths: c.validityMonths },
      });
      return course;
    } catch (error) {
      if ((error as { code?: string }).code === "P2002")
        throw conflict("A course with this code exists", { field: "code" });
      throw error;
    }
  });
}

export async function setCourseArchived(ctx: TenantContext, courseId: string, archived: boolean) {
  if (!canManageCatalogue(ctx)) throw forbidden();
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.trainingCourse.findFirst({
      where: { organizationId: ctx.organizationId, id: courseId },
    });
    if (!c) throw notFound("Course");
    await tx.trainingCourse.update({
      where: { id: c.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "training_course.archived" : "training_course.restored",
      entityType: "training_course",
      entityId: c.id,
    });
  });
}

const requirementSchema = z
  .object({
    courseId: uuidSchema,
    scope: z.enum(TRAINING_SCOPES, { error: "invalidOption" }),
    jobTitle: optionalText(120),
    departmentId: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined))
      .pipe(z.uuid().optional()),
    branchId: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined))
      .pipe(z.uuid().optional()),
    dueWithinDays: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : "30"))
      .refine((v) => /^\d{1,3}$/.test(v) && Number(v) <= 365, { error: "invalidDays" })
      .transform(Number),
  })
  .refine((r) => r.scope !== "JOB_TITLE" || r.jobTitle, { error: "required", path: ["jobTitle"] })
  .refine((r) => r.scope !== "DEPARTMENT" || r.departmentId, {
    error: "required",
    path: ["departmentId"],
  })
  .refine((r) => r.scope !== "BRANCH" || r.branchId, { error: "required", path: ["branchId"] });

export async function addRequirement(ctx: TenantContext, rawInput: unknown) {
  if (!canManageCatalogue(ctx)) throw forbidden();
  const parsed = requirementSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const r = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const course = await tx.trainingCourse.findFirst({
      where: { organizationId: ctx.organizationId, id: r.courseId, archivedAt: null },
      select: { id: true, code: true },
    });
    if (!course) throw notFound("Course");
    if (r.scope === "DEPARTMENT") {
      const ok = await tx.department.findFirst({
        where: { organizationId: ctx.organizationId, id: r.departmentId!, archivedAt: null },
      });
      if (!ok) throw notFound("Department");
    }
    if (r.scope === "BRANCH") {
      const ok = await tx.branch.findFirst({
        where: { organizationId: ctx.organizationId, id: r.branchId!, archivedAt: null },
      });
      if (!ok) throw notFound("Branch");
    }
    const requirement = await tx.trainingRequirement.create({
      data: {
        organizationId: ctx.organizationId,
        courseId: course.id,
        scope: r.scope,
        jobTitle: r.scope === "JOB_TITLE" ? r.jobTitle!.trim() : null,
        departmentId: r.scope === "DEPARTMENT" ? r.departmentId! : null,
        branchId: r.scope === "BRANCH" ? r.branchId! : null,
        dueWithinDays: r.dueWithinDays,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "training_requirement.added",
      entityType: "training_course",
      entityId: course.id,
      changes: { scope: r.scope, jobTitle: r.jobTitle ?? null, dueWithinDays: r.dueWithinDays },
    });
    return requirement;
  });
}

export async function removeRequirement(ctx: TenantContext, requirementId: string) {
  if (!canManageCatalogue(ctx)) throw forbidden();
  await withTenantTx(ctx.organizationId, async (tx) => {
    const r = await tx.trainingRequirement.findFirst({
      where: { organizationId: ctx.organizationId, id: requirementId },
    });
    if (!r) throw notFound("Requirement");
    await tx.trainingRequirement.delete({ where: { id: r.id } });
    await recordAudit(tx, actorOf(ctx), {
      action: "training_requirement.removed",
      entityType: "training_course",
      entityId: r.courseId,
      changes: { scope: r.scope },
    });
  });
}

export async function listCourses(ctx: TenantContext, includeArchived = false) {
  if (!canViewTraining(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => ({
    courses: await tx.trainingCourse.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: {
        requirements: { orderBy: { createdAt: "asc" } },
        _count: { select: { records: { where: { voidedAt: null } } } },
      },
      orderBy: { code: "asc" },
    }),
    departments: await tx.department.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    branches: await tx.branch.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    canManage: canManageCatalogue(ctx),
  }));
}

// ─── Sessions ───

const sessionSchema = z.object({
  courseId: uuidSchema,
  branchId: uuidSchema,
  date,
  time: z.string().refine((v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v), { error: "invalidFormat" }),
  location: optionalText(120),
  trainer: requiredText(120),
  capacity: optionalInt(500),
});

export async function scheduleSession(ctx: TenantContext, rawInput: unknown) {
  const parsed = sessionSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const s = parsed.data;
  if (!canManageAt(ctx, s.branchId)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [course, branch] = await inSequence([
      tx.trainingCourse.findFirst({
        where: { organizationId: ctx.organizationId, id: s.courseId, archivedAt: null },
        select: { id: true },
      }),
      tx.branch.findFirst({
        where: { organizationId: ctx.organizationId, id: s.branchId, archivedAt: null },
        select: { id: true, timeZone: true },
      }),
    ]);
    if (!course) throw notFound("Course");
    if (!branch) throw notFound("Branch");
    const session = await tx.trainingSession.create({
      data: {
        organizationId: ctx.organizationId,
        number: await nextDocumentNumber(tx, ctx.organizationId, "TRN", Number(s.date.slice(0, 4))),
        courseId: course.id,
        branchId: branch.id,
        startsAt: zonedInstant(s.date, s.time, branch.timeZone ?? ctx.timeZone),
        location: s.location,
        trainer: s.trainer,
        capacity: s.capacity,
        createdByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "training_session.scheduled",
      entityType: "training_session",
      entityId: session.id,
      changes: { number: session.number, date: s.date },
    });
    return session;
  });
}

async function loadSession(tx: Tx, ctx: TenantContext, sessionId: string) {
  const s = await tx.trainingSession.findFirst({
    where: { organizationId: ctx.organizationId, id: sessionId },
    include: {
      course: true,
      branch: { select: { id: true, code: true, name: true, timeZone: true } },
    },
  });
  if (!s || !canViewAt(ctx, s.branchId)) throw notFound("Training session");
  return s;
}

async function openSession(tx: Tx, ctx: TenantContext, sessionId: string) {
  const s = await loadSession(tx, ctx, sessionId);
  if (!canManageAt(ctx, s.branchId)) throw forbidden();
  if (s.status !== "SCHEDULED")
    throw businessRuleViolation("TRAINING_SESSION_CLOSED", "The session is no longer open");
  return s;
}

export async function addParticipants(ctx: TenantContext, sessionId: string, rawIds: unknown) {
  const parsed = z
    .array(uuidSchema)
    .min(1, { error: "nothingSelected" })
    .max(200)
    .safeParse(rawIds);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await openSession(tx, ctx, sessionId);
    const employees = await tx.employee.findMany({
      where: {
        organizationId: ctx.organizationId,
        id: { in: parsed.data },
        status: { not: "TERMINATED" },
      },
      select: { id: true, branchId: true },
    });
    if (employees.length !== new Set(parsed.data).size) throw notFound("Employee");
    // Staff of other branches join only if the person may manage training there too.
    if (employees.some((e) => !canManageAt(ctx, e.branchId))) throw forbidden();
    const already = await tx.trainingParticipant.count({
      where: { organizationId: ctx.organizationId, sessionId: s.id },
    });
    const fresh = employees.filter(Boolean);
    if (s.capacity && already + fresh.length > s.capacity)
      throw businessRuleViolation("TRAINING_SESSION_FULL", "The session is full", {
        capacity: s.capacity,
      });
    await tx.trainingParticipant.createMany({
      data: fresh.map((e) => ({
        organizationId: ctx.organizationId,
        sessionId: s.id,
        employeeId: e.id,
      })),
      skipDuplicates: true,
    });
  });
}

const attendanceSchema = z
  .object({
    attendance: z.enum(["INVITED", "ATTENDED", "ABSENT"]),
    result: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined))
      .pipe(z.enum(["PASSED", "FAILED"]).optional()),
    note: optionalText(300),
  })
  .refine((a) => a.attendance === "ATTENDED" || !a.result, {
    error: "resultNeedsAttendance",
    path: ["result"],
  });

export async function recordAttendance(
  ctx: TenantContext,
  sessionId: string,
  employeeId: string,
  rawInput: unknown,
) {
  const parsed = attendanceSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await openSession(tx, ctx, sessionId);
    const r = await tx.trainingParticipant.updateMany({
      where: { organizationId: ctx.organizationId, sessionId: s.id, employeeId },
      data: {
        attendance: parsed.data.attendance,
        result: parsed.data.result ?? null,
        note: parsed.data.note,
      },
    });
    if (r.count === 0) throw notFound("Participant");
  });
}

/**
 * Close the session: everyone must be marked attended (with a result) or
 * absent. Those who passed get a training record dated the session's day,
 * expiring by the course's validity.
 */
export async function completeSession(ctx: TenantContext, sessionId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await openSession(tx, ctx, sessionId);
    const people = await tx.trainingParticipant.findMany({
      where: { organizationId: ctx.organizationId, sessionId: s.id },
      select: { employeeId: true, attendance: true, result: true },
    });
    if (people.length === 0)
      throw businessRuleViolation("TRAINING_SESSION_EMPTY", "Nobody is on this session");
    const open = people.filter(
      (p) => p.attendance === "INVITED" || (p.attendance === "ATTENDED" && !p.result),
    );
    if (open.length)
      throw businessRuleViolation(
        "TRAINING_ATTENDANCE_MISSING",
        "Mark everyone's attendance and result",
        {
          count: open.length,
        },
      );
    const held = businessDate(s.branch.timeZone ?? ctx.timeZone, s.startsAt);
    const passed = people.filter((p) => p.result === "PASSED");
    if (passed.length)
      await tx.trainingRecord.createMany({
        data: passed.map((p) => ({
          organizationId: ctx.organizationId,
          employeeId: p.employeeId,
          courseId: s.courseId,
          completedOn: asDate(held),
          expiresOn: (() => {
            const e = expiryFor(held, s.course.validityMonths);
            return e ? asDate(e) : null;
          })(),
          source: "SESSION" as const,
          sessionId: s.id,
          provider: s.trainer,
          recordedByUserId: ctx.userId,
        })),
      });
    await tx.trainingSession.update({
      where: { id: s.id },
      data: { status: "COMPLETED", completedAt: new Date(), completedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "training_session.completed",
      entityType: "training_session",
      entityId: s.id,
      changes: {
        attended: people.filter((p) => p.attendance === "ATTENDED").length,
        passed: passed.length,
      },
    });
    return { passed: passed.length };
  });
}

export async function cancelSession(ctx: TenantContext, sessionId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(200) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await openSession(tx, ctx, sessionId);
    await tx.trainingSession.update({
      where: { id: s.id },
      data: { status: "CANCELLED", cancelReason: parsed.data.reason },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "training_session.cancelled",
      entityType: "training_session",
      entityId: s.id,
      changes: { reason: parsed.data.reason },
    });
  });
}

export async function listSessions(ctx: TenantContext) {
  if (!canViewTraining(ctx)) throw forbidden();
  const branches = viewBranches(ctx);
  return withTenantTx(ctx.organizationId, async (tx) => ({
    sessions: await tx.trainingSession.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(branches ? { branchId: { in: branches } } : {}),
      },
      include: {
        course: { select: { code: true, name: true, nameAr: true } },
        branch: { select: { code: true, name: true, timeZone: true } },
        _count: { select: { participants: true } },
      },
      orderBy: { startsAt: "desc" },
      take: 100,
    }),
  }));
}

export async function getSession(ctx: TenantContext, sessionId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadSession(tx, ctx, sessionId);
    const [participants, candidates] = await inSequence([
      tx.trainingParticipant.findMany({
        where: { organizationId: ctx.organizationId, sessionId: s.id },
        include: {
          employee: {
            select: { id: true, number: true, firstName: true, lastName: true, jobTitle: true },
          },
        },
        orderBy: { employee: { number: "asc" } },
      }),
      tx.employee.findMany({
        where: {
          organizationId: ctx.organizationId,
          branchId: s.branchId,
          status: { not: "TERMINATED" },
        },
        select: { id: true, number: true, firstName: true, lastName: true },
        orderBy: { number: "asc" },
      }),
    ]);
    const on = new Set(participants.map((p) => p.employeeId));
    return {
      session: s,
      participants,
      candidates: candidates.filter((c) => !on.has(c.id)),
      canManage: canManageAt(ctx, s.branchId) && s.status === "SCHEDULED",
    };
  });
}

// ─── Records ───

const externalSchema = z.object({
  courseId: uuidSchema,
  completedOn: date,
  provider: requiredText(120),
  certificateNumber: optionalText(60),
  note: optionalText(300),
});

/** A course passed elsewhere (an outside provider, a municipality course). */
export async function addExternalRecord(ctx: TenantContext, employeeId: string, rawInput: unknown) {
  const parsed = externalSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const r = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await tx.employee.findFirst({
      where: { organizationId: ctx.organizationId, id: employeeId },
      select: { id: true, branchId: true },
    });
    if (!e || !canViewAt(ctx, e.branchId)) throw notFound("Employee");
    if (!canManageAt(ctx, e.branchId)) throw forbidden();
    if (r.completedOn > businessDate(ctx.timeZone))
      throw businessRuleViolation("TRAINING_IN_FUTURE", "The completion date is in the future", {
        field: "completedOn",
      });
    const course = await tx.trainingCourse.findFirst({
      where: { organizationId: ctx.organizationId, id: r.courseId },
      select: { id: true, code: true, validityMonths: true },
    });
    if (!course) throw notFound("Course");
    const expires = expiryFor(r.completedOn, course.validityMonths);
    const record = await tx.trainingRecord.create({
      data: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        courseId: course.id,
        completedOn: asDate(r.completedOn),
        expiresOn: expires ? asDate(expires) : null,
        source: "EXTERNAL",
        provider: r.provider,
        certificateNumber: r.certificateNumber,
        note: r.note,
        recordedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "training_record.added",
      entityType: "employee",
      entityId: e.id,
      changes: { course: course.code, completedOn: r.completedOn, expiresOn: expires },
    });
    return record;
  });
}

export async function voidRecord(ctx: TenantContext, recordId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(200) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const r = await tx.trainingRecord.findFirst({
      where: { organizationId: ctx.organizationId, id: recordId },
      include: { employee: { select: { branchId: true } } },
    });
    if (!r || !canViewAt(ctx, r.employee.branchId)) throw notFound("Training record");
    if (!canManageAt(ctx, r.employee.branchId)) throw forbidden();
    if (r.voidedAt) throw businessRuleViolation("TRAINING_RECORD_VOIDED", "Already voided");
    await tx.trainingRecord.update({
      where: { id: r.id },
      data: { voidedAt: new Date(), voidedByUserId: ctx.userId, voidReason: parsed.data.reason },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "training_record.voided",
      entityType: "employee",
      entityId: r.employeeId,
      changes: { reason: parsed.data.reason },
    });
  });
}

// ─── Compliance ───

export interface ComplianceCell {
  courseId: string;
  status: ComplianceStatus;
  dueOn: string | null;
  expiresOn: string | null;
}

/** Each in-scope active employee against every course required of them. */
async function complianceInTx(
  tx: Tx,
  ctx: TenantContext,
  filters: { branchId?: string; employeeId?: string; branchIds?: string[] | null },
) {
  const today = businessDate(ctx.timeZone);
  const [requirements, employees] = await inSequence([
    tx.trainingRequirement.findMany({
      where: { organizationId: ctx.organizationId, course: { archivedAt: null } },
      include: { course: { select: { id: true, code: true, name: true, nameAr: true } } },
    }),
    tx.employee.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { not: "TERMINATED" },
        ...(filters.employeeId ? { id: filters.employeeId } : {}),
        ...(filters.branchId ? { branchId: filters.branchId } : {}),
        ...(filters.branchIds ? { branchId: { in: filters.branchIds } } : {}),
      },
      select: {
        id: true,
        number: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        departmentId: true,
        branchId: true,
        hireDate: true,
        branch: { select: { code: true } },
        trainingRecords: {
          where: { voidedAt: null },
          select: { courseId: true, completedOn: true, expiresOn: true },
        },
      },
      orderBy: { number: "asc" },
    }),
  ]);
  const courses = new Map(requirements.map((r) => [r.courseId, r.course]));
  const rows = employees.map((e) => {
    // The shortest deadline wins when several requirements name the same course.
    const due = new Map<string, number>();
    for (const r of requirements)
      if (requirementApplies(r, e))
        due.set(r.courseId, Math.min(due.get(r.courseId) ?? Infinity, r.dueWithinDays));
    const cells: ComplianceCell[] = [...due].map(([courseId, dueWithinDays]) => {
      const latest = latestRecord(
        e.trainingRecords
          .filter((x) => x.courseId === courseId)
          .map((x) => ({
            completedOn: day(x.completedOn),
            expiresOn: x.expiresOn ? day(x.expiresOn) : null,
          })),
      );
      return {
        courseId,
        ...complianceStatus({ today, hireDate: day(e.hireDate), dueWithinDays, latest }),
      };
    });
    return { employee: e, cells };
  });
  return {
    today,
    courses: [...courses.values()].sort((a, b) => a.code.localeCompare(b.code)),
    rows,
  };
}

export async function complianceMatrix(ctx: TenantContext, filters: { branchId?: string } = {}) {
  if (!canViewTraining(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const m = await complianceInTx(tx, ctx, {
      branchId: filters.branchId,
      branchIds: viewBranches(ctx),
    });
    const counts: Record<ComplianceStatus, number> = {
      COMPLIANT: 0,
      EXPIRING: 0,
      EXPIRED: 0,
      DUE: 0,
      OVERDUE: 0,
    };
    for (const r of m.rows) for (const c of r.cells) counts[c.status]++;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      ...m,
      counts,
      // Share of required courses held and valid today (expiring still counts).
      compliantShare: total ? (counts.COMPLIANT + counts.EXPIRING) / total : null,
      branches: await tx.branch.findMany({
        where: {
          organizationId: ctx.organizationId,
          archivedAt: null,
          ...(viewBranches(ctx) ? { id: { in: viewBranches(ctx)! } } : {}),
        },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
    };
  });
}

export async function exportComplianceCsv(ctx: TenantContext, filters: { branchId?: string } = {}) {
  const m = await complianceMatrix(ctx, filters);
  const code = new Map(m.courses.map((c) => [c.id, c.code]));
  return toCsv(
    ["employee_number", "name", "branch", "job_title", "course", "status", "due_on", "expires_on"],
    m.rows.flatMap((r) =>
      r.cells.map((c) => [
        r.employee.number,
        `${r.employee.firstName} ${r.employee.lastName}`,
        r.employee.branch.code,
        r.employee.jobTitle,
        code.get(c.courseId) ?? "",
        c.status,
        c.dueOn ?? "",
        c.expiresOn ?? "",
      ]),
    ),
  );
}

/** An employee's records and where they stand on each required course. */
export async function employeeTraining(ctx: TenantContext, employeeId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await tx.employee.findFirst({
      where: { organizationId: ctx.organizationId, id: employeeId },
      select: { id: true, branchId: true, userId: true },
    });
    const own = e?.userId === ctx.userId;
    if (!e || (!own && !canViewAt(ctx, e.branchId))) throw notFound("Employee");
    const [records, m, courses] = await inSequence([
      tx.trainingRecord.findMany({
        where: { organizationId: ctx.organizationId, employeeId: e.id },
        include: { course: { select: { code: true, name: true, nameAr: true } } },
        orderBy: { completedOn: "desc" },
      }),
      complianceInTx(tx, ctx, { employeeId: e.id }),
      tx.trainingCourse.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
    ]);
    return {
      records,
      required: m.rows[0]?.cells ?? [],
      courses,
      courseNames: new Map(m.courses.map((c) => [c.id, c])),
      canManage: canManageAt(ctx, e.branchId),
    };
  });
}

/** The signed-in person's own training. */
export async function myTraining(ctx: TenantContext) {
  const me = await withTenantTx(ctx.organizationId, (tx) =>
    tx.employee.findFirst({
      where: { organizationId: ctx.organizationId, userId: ctx.userId },
      select: { id: true },
    }),
  );
  if (!me) throw forbidden();
  return employeeTraining(ctx, me.id);
}

/** Counts for the needs-attention list: expired or overdue, and expiring soon. */
export async function trainingAttentionInTx(tx: Tx, ctx: TenantContext) {
  if (!canViewTraining(ctx)) return null;
  const m = await complianceInTx(tx, ctx, { branchIds: viewBranches(ctx) });
  let lapsed = 0;
  let expiring = 0;
  for (const r of m.rows)
    for (const c of r.cells) {
      if (c.status === "EXPIRED" || c.status === "OVERDUE") lapsed++;
      if (c.status === "EXPIRING") expiring++;
    }
  return { lapsed, expiring };
}
