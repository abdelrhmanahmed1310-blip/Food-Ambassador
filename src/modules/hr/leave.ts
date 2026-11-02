import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { isCalendarDate } from "@/lib/dates";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import { COMMON_LEAVE_TYPES, leaveDays } from "./leave-rules";
import { canViewHr } from "./service";

/**
 * Leave (DECISIONS.md ADR-081). HR defines leave types (common ones offered,
 * entitlements never invented) and each employee's yearly entitlement; the
 * employee or HR requests leave; the employee's manager (through their
 * linked account) or an HR manager of the branch approves or rejects it.
 * Balance = entitlement − approved − pending, for types that use a balance.
 */

const dateSchema = z.string().trim().refine(isCalendarDate, { error: "invalidDate" });
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);
const dec = (v: { toString(): string }) => new Decimal(v.toString());

function viewBranches(ctx: TenantContext): Prisma.EmployeeWhereInput {
  const v = accessibleScope(ctx.grants, "hr.view");
  const m = accessibleScope(ctx.grants, "hr.manage");
  if (v.all || m.all) return {};
  return { branchId: { in: [...v.branchIds, ...m.branchIds] } };
}
const canManageBranch = (ctx: TenantContext, branchId: string) =>
  hasPermission(ctx.grants, "hr.manage", { branchId });

/** The employee record of the signed-in user, if any. */
async function selfEmployee(tx: Tx, ctx: TenantContext) {
  return tx.employee.findFirst({
    where: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      status: { not: "TERMINATED" },
    },
  });
}

// ─── Types ───

const typeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, { error: "required" })
    .max(20, { error: "tooLong" })
    .transform((v) => v.toUpperCase()),
  name: requiredText(80),
  nameAr: optionalText(80),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z]{2})?$/, { error: "invalid" })
    .optional()
    .transform((v) => v || null),
  paid: z
    .union([z.literal("on"), z.literal("true"), z.literal(""), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "on" || v === "true"),
  usesBalance: z
    .union([z.literal("on"), z.literal("true"), z.literal(""), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "on" || v === "true"),
});

export async function listLeaveTypes(ctx: TenantContext, includeArchived = false) {
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.leaveType.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: { code: "asc" },
    }),
  );
}

export async function createLeaveType(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "hr.manage");
  const parsed = typeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const t = await tx.leaveType.create({
        data: { organizationId: ctx.organizationId, ...parsed.data },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "leave_type.created",
        entityType: "leave_type",
        entityId: t.id,
        changes: parsed.data,
      });
      return t;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw businessRuleViolation("LEAVE_TYPE_CODE_TAKEN", "This code is already used", {
        field: "code",
      });
    throw error;
  }
}

/** Adds the common types that are not there yet (by code). */
export async function addCommonLeaveTypes(ctx: TenantContext) {
  assertPermission(ctx.grants, "hr.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const existing = new Set(
      (
        await tx.leaveType.findMany({
          where: { organizationId: ctx.organizationId },
          select: { code: true },
        })
      ).map((t) => t.code),
    );
    const added = COMMON_LEAVE_TYPES.filter((t) => !existing.has(t.code));
    for (const t of added)
      await tx.leaveType.create({ data: { organizationId: ctx.organizationId, ...t } });
    if (added.length > 0)
      await recordAudit(tx, actorOf(ctx), {
        action: "leave_type.common_added",
        entityType: "organization",
        entityId: ctx.organizationId,
        changes: { codes: added.map((t) => t.code) },
      });
    return added.length;
  });
}

export async function setLeaveTypeArchived(ctx: TenantContext, id: string, archived: boolean) {
  assertPermission(ctx.grants, "hr.manage");
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) throw notFound("Leave type");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const t = await tx.leaveType.findFirst({
      where: { organizationId: ctx.organizationId, id: parsed.data },
    });
    if (!t) throw notFound("Leave type");
    await tx.leaveType.update({
      where: { id: t.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "leave_type.archived" : "leave_type.restored",
      entityType: "leave_type",
      entityId: t.id,
      changes: {},
    });
  });
}

// ─── Entitlements and balances ───

const allocationSchema = z.object({
  leaveTypeId: uuidSchema,
  year: z.coerce.number().int().min(2000).max(2100),
  days: z.coerce
    .number({ error: "invalid" })
    .min(0, { error: "invalid" })
    .max(366, { error: "invalid" }),
  note: optionalText(200),
});

export async function setLeaveAllocation(
  ctx: TenantContext,
  employeeId: string,
  rawInput: unknown,
) {
  const parsed = allocationSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployee(tx, ctx, employeeId);
    if (!canManageBranch(ctx, e.branchId)) throw forbidden();
    const type = await loadType(tx, ctx, v.leaveTypeId);
    if (!type.usesBalance)
      throw businessRuleViolation(
        "LEAVE_TYPE_NO_BALANCE",
        "This leave type does not use a balance",
        {
          field: "leaveTypeId",
        },
      );
    const days = new Decimal(v.days).toFixed(2);
    await tx.leaveAllocation.upsert({
      where: {
        organizationId_employeeId_leaveTypeId_year: {
          organizationId: ctx.organizationId,
          employeeId: e.id,
          leaveTypeId: type.id,
          year: v.year,
        },
      },
      create: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        leaveTypeId: type.id,
        year: v.year,
        days,
        note: v.note ?? null,
      },
      update: { days, note: v.note ?? null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "leave_allocation.set",
      entityType: "employee",
      entityId: e.id,
      changes: { leaveType: type.code, year: v.year, days },
    });
  });
}

/** Per type that uses a balance: entitlement, approved, pending and remaining days for the year. */
async function balancesInTx(tx: Tx, organizationId: string, employeeId: string, year: number) {
  const [types, allocations, requests] = await Promise.all([
    tx.leaveType.findMany({
      where: { organizationId, archivedAt: null },
      orderBy: { code: "asc" },
    }),
    tx.leaveAllocation.findMany({ where: { organizationId, employeeId, year } }),
    tx.leaveRequest.findMany({
      where: {
        organizationId,
        employeeId,
        status: { in: ["PENDING", "APPROVED"] },
        startDate: { gte: asDate(`${year}-01-01`), lte: asDate(`${year}-12-31`) },
      },
      select: { leaveTypeId: true, status: true, days: true },
    }),
  ]);
  return types.map((t) => {
    const entitled = allocations.find((a) => a.leaveTypeId === t.id);
    const sum = (s: "APPROVED" | "PENDING") =>
      requests
        .filter((r) => r.leaveTypeId === t.id && r.status === s)
        .reduce((a, r) => a.plus(dec(r.days)), new Decimal(0));
    const approved = sum("APPROVED");
    const pending = sum("PENDING");
    const allocated = entitled ? dec(entitled.days) : null;
    return {
      type: t,
      allocated,
      approved,
      pending,
      remaining: t.usesBalance && allocated ? allocated.minus(approved).minus(pending) : null,
    };
  });
}

// ─── Requests ───

const requestSchema = z
  .object({
    leaveTypeId: uuidSchema,
    startDate: dateSchema,
    endDate: dateSchema,
    reason: optionalText(300),
  })
  .refine((v) => v.endDate >= v.startDate, { error: "invalid", path: ["endDate"] })
  .refine((v) => v.startDate.slice(0, 4) === v.endDate.slice(0, 4), {
    error: "leaveOneYear",
    path: ["endDate"],
  });

async function loadEmployee(tx: Tx, ctx: TenantContext, id: string) {
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) throw notFound("Employee");
  const self = await selfEmployee(tx, ctx);
  const e = await tx.employee.findFirst({
    where: {
      organizationId: ctx.organizationId,
      id: parsed.data,
      ...(self?.id === parsed.data ? {} : { AND: [viewBranches(ctx)] }),
    },
  });
  if (!e || (self?.id !== e.id && !canViewHr(ctx))) throw notFound("Employee");
  return e;
}

async function loadType(tx: Tx, ctx: TenantContext, id: string) {
  const t = await tx.leaveType.findFirst({
    where: { organizationId: ctx.organizationId, id, archivedAt: null },
  });
  if (!t)
    throw businessRuleViolation("LEAVE_TYPE_INVALID", "Choose a leave type", {
      field: "leaveTypeId",
    });
  return t;
}

/** Request leave for oneself, or (HR managing the branch) for an employee. */
export async function requestLeave(
  ctx: TenantContext,
  employeeId: string | null,
  rawInput: unknown,
) {
  const parsed = requestSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const self = await selfEmployee(tx, ctx);
    const e = employeeId ? await loadEmployee(tx, ctx, employeeId) : self;
    if (!e)
      throw businessRuleViolation(
        "ATTENDANCE_NOT_EMPLOYEE",
        "Your account is not linked to an employee",
      );
    if (e.id !== self?.id && !canManageBranch(ctx, e.branchId)) throw forbidden();
    if (e.status === "TERMINATED")
      throw businessRuleViolation("EMPLOYEE_TERMINATED", "Rehire the employee first");
    const type = await loadType(tx, ctx, v.leaveTypeId);
    await tx.$queryRaw`SELECT 1 FROM "employees" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${e.id}::uuid FOR UPDATE`;
    const clash = await tx.leaveRequest.findFirst({
      where: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        status: { in: ["PENDING", "APPROVED"] },
        startDate: { lte: asDate(v.endDate) },
        endDate: { gte: asDate(v.startDate) },
      },
    });
    if (clash)
      throw businessRuleViolation("LEAVE_OVERLAP", "This overlaps another leave request", {
        field: "startDate",
      });
    const days = leaveDays(v.startDate, v.endDate);
    if (type.usesBalance) {
      const b = (
        await balancesInTx(tx, ctx.organizationId, e.id, Number(v.startDate.slice(0, 4)))
      ).find((x) => x.type.id === type.id)!;
      if (!b.remaining || b.remaining.lessThan(days))
        throw businessRuleViolation(
          "LEAVE_BALANCE_SHORT",
          "Not enough days left for this leave type",
          {
            field: "endDate",
            remaining: b.remaining?.toFixed(2) ?? "0",
          },
        );
    }
    const r = await tx.leaveRequest.create({
      data: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        leaveTypeId: type.id,
        startDate: asDate(v.startDate),
        endDate: asDate(v.endDate),
        days: String(days),
        reason: v.reason ?? null,
        requestedByUserId: ctx.userId,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "leave.requested",
      entityType: "employee",
      entityId: e.id,
      changes: { leaveType: type.code, startDate: v.startDate, endDate: v.endDate, days },
    });
    return r;
  });
}

/** May the user decide this employee's leave? Their direct manager (linked account) or HR for the branch. */
async function canDecide(
  tx: Tx,
  ctx: TenantContext,
  employee: { id: string; branchId: string; managerId: string | null; userId: string | null },
) {
  // Nobody decides their own leave, whatever their role.
  if (employee.userId && employee.userId === ctx.userId) return false;
  if (canManageBranch(ctx, employee.branchId)) return true;
  const self = await selfEmployee(tx, ctx);
  return Boolean(self && employee.managerId === self.id && self.id !== employee.id);
}

const decisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"], { error: "invalidOption" }),
  note: optionalText(300),
});

export async function decideLeave(ctx: TenantContext, requestId: string, rawInput: unknown) {
  const id = uuidSchema.safeParse(requestId);
  if (!id.success) throw notFound("Leave request");
  const parsed = decisionSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "leave_requests" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${id.data}::uuid FOR UPDATE`;
    const r = await tx.leaveRequest.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data },
      include: { employee: true, leaveType: true },
    });
    if (!r || !(await canDecide(tx, ctx, r.employee))) throw notFound("Leave request");
    if (r.status !== "PENDING")
      throw businessRuleViolation("LEAVE_DECIDED", "This request is already decided");
    await tx.leaveRequest.update({
      where: { id: r.id },
      data: {
        status: parsed.data.decision,
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        decisionNote: parsed.data.note ?? null,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: parsed.data.decision === "APPROVED" ? "leave.approved" : "leave.rejected",
      entityType: "employee",
      entityId: r.employeeId,
      changes: {
        leaveType: r.leaveType.code,
        startDate: day(r.startDate),
        endDate: day(r.endDate),
        note: parsed.data.note,
      },
    });
  });
}

/**
 * Cancel a request: the employee (or HR) while it is pending; HR also after
 * approval if the leave has not started. Days go back to the balance.
 */
export async function cancelLeave(ctx: TenantContext, requestId: string) {
  const id = uuidSchema.safeParse(requestId);
  if (!id.success) throw notFound("Leave request");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const r = await tx.leaveRequest.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data },
      include: { employee: true },
    });
    if (!r) throw notFound("Leave request");
    const self = await selfEmployee(tx, ctx);
    const hr = canManageBranch(ctx, r.employee.branchId);
    if (!hr && self?.id !== r.employeeId) throw notFound("Leave request");
    const today = businessDate(ctx.timeZone);
    const allowed =
      r.status === "PENDING" || (hr && r.status === "APPROVED" && day(r.startDate) > today);
    if (!allowed)
      throw businessRuleViolation(
        "LEAVE_NOT_CANCELLABLE",
        "This request can no longer be cancelled",
      );
    await tx.leaveRequest.update({
      where: { id: r.id },
      data: { status: "CANCELLED", decidedByUserId: ctx.userId, decidedAt: new Date() },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "leave.cancelled",
      entityType: "employee",
      entityId: r.employeeId,
      changes: { startDate: day(r.startDate), endDate: day(r.endDate), was: r.status },
    });
  });
}

const requestInclude = {
  employee: {
    select: {
      id: true,
      number: true,
      firstName: true,
      lastName: true,
      branchId: true,
      managerId: true,
      userId: true,
    },
  },
  leaveType: { select: { code: true, name: true, nameAr: true, paid: true } },
} satisfies Prisma.LeaveRequestInclude;

/** HR's list (scoped), newest first; optionally only one status. */
export async function listLeaveRequests(ctx: TenantContext, rawStatus?: unknown) {
  if (!canViewHr(ctx)) throw forbidden();
  const status = z
    .enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"])
    .optional()
    .catch(undefined)
    .parse(rawStatus || undefined);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.leaveRequest.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(status ? { status } : {}),
        employee: viewBranches(ctx),
      },
      include: requestInclude,
      orderBy: [{ status: "asc" }, { startDate: "desc" }],
      take: 200,
    });
    return rows.map((r) => ({
      ...r,
      canDecide:
        r.status === "PENDING" &&
        canManageBranch(ctx, r.employee.branchId) &&
        r.employee.userId !== ctx.userId,
    }));
  });
}

/** The signed-in employee's leave: balances, own requests, and their team's requests to decide. */
export async function myLeave(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const self = await selfEmployee(tx, ctx);
    if (!self) return null;
    const year = Number(businessDate(ctx.timeZone).slice(0, 4));
    const [balances, mine, team] = await Promise.all([
      balancesInTx(tx, ctx.organizationId, self.id, year),
      tx.leaveRequest.findMany({
        where: { organizationId: ctx.organizationId, employeeId: self.id },
        include: requestInclude,
        orderBy: { startDate: "desc" },
        take: 50,
      }),
      tx.leaveRequest.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: "PENDING",
          employee: { managerId: self.id },
        },
        include: requestInclude,
        orderBy: { startDate: "asc" },
      }),
    ]);
    return { employee: self, year, balances, mine, team };
  });
}

/** An employee's balances and requests for a year (HR, employee page). */
export async function employeeLeave(ctx: TenantContext, employeeId: string, year?: number) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployee(tx, ctx, employeeId);
    const y = year ?? Number(businessDate(ctx.timeZone).slice(0, 4));
    const [balances, requests] = await Promise.all([
      balancesInTx(tx, ctx.organizationId, e.id, y),
      tx.leaveRequest.findMany({
        where: { organizationId: ctx.organizationId, employeeId: e.id },
        include: requestInclude,
        orderBy: { startDate: "desc" },
        take: 30,
      }),
    ]);
    return { year: y, balances, requests, can: { manage: canManageBranch(ctx, e.branchId) } };
  });
}

/** Approved leave on a day, for the attendance board and HR overview. */
export async function onLeaveOn(ctx: TenantContext, dayIso: string) {
  return withTenantTx(
    ctx.organizationId,
    async (tx) =>
      new Set(
        (
          await tx.leaveRequest.findMany({
            where: {
              organizationId: ctx.organizationId,
              status: "APPROVED",
              startDate: { lte: asDate(dayIso) },
              endDate: { gte: asDate(dayIso) },
              employee: viewBranches(ctx),
            },
            select: { employeeId: true },
          })
        ).map((r) => r.employeeId),
      ),
  );
}
