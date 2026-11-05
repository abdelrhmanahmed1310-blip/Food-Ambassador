import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { isCalendarDate } from "@/lib/dates";
import {
  accessibleScope,
  assertPermission,
  hasPermission,
  holdsAnyGrant,
} from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import { createsReportingLoop, documentState, EXPIRY_WARNING_DAYS, orgTree } from "./rules";

/**
 * HRIS (DECISIONS.md ADR-079): departments, employee records with their
 * reporting line, and employee documents with expiry dates. Employees belong
 * to a branch; hr.view and hr.manage can be granted per branch. ID and
 * document numbers are personal data: only hr.manage sees them, and they are
 * never written to the audit log.
 */

export const PAGE_SIZE = 25;
export const EMPLOYEE_STATUSES = ["ACTIVE", "ON_LEAVE", "TERMINATED"] as const;
export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "TEMPORARY"] as const;
export const DOCUMENT_TYPES = [
  "NATIONAL_ID",
  "IQAMA",
  "PASSPORT",
  "WORK_PERMIT",
  "HEALTH_CERTIFICATE",
  "DRIVING_LICENSE",
  "CONTRACT",
  "OTHER",
] as const;

const dateSchema = z.string().trim().refine(isCalendarDate, { error: "invalidDate" });
const optionalDate = z
  .union([z.literal(""), dateSchema])
  .optional()
  .transform((v) => (v ? v : null));
const optionalUuid = z
  .union([z.literal(""), uuidSchema])
  .optional()
  .transform((v) => (v ? v : null));
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);

export function canViewHr(ctx: TenantContext) {
  return holdsAnyGrant(ctx.grants, "hr.view") || holdsAnyGrant(ctx.grants, "hr.manage");
}

function viewFilter(ctx: TenantContext): Prisma.EmployeeWhereInput {
  const view = accessibleScope(ctx.grants, "hr.view");
  const manage = accessibleScope(ctx.grants, "hr.manage");
  if (view.all || manage.all) return {};
  return { branchId: { in: [...view.branchIds, ...manage.branchIds] } };
}
function assertView(ctx: TenantContext) {
  if (!canViewHr(ctx)) throw forbidden();
}
const canManageBranch = (ctx: TenantContext, branchId: string) =>
  hasPermission(ctx.grants, "hr.manage", { branchId });

// ─── Departments ───

const departmentSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, { error: "required" })
    .max(20, { error: "tooLong" })
    .transform((v) => v.toUpperCase()),
  name: requiredText(120),
  nameAr: optionalText(120),
  parentId: optionalUuid,
});

export async function listDepartments(ctx: TenantContext, includeArchived = false) {
  assertView(ctx);
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.department.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: {
        parent: { select: { code: true, name: true } },
        _count: { select: { employees: { where: { status: { not: "TERMINATED" } } } } },
      },
      orderBy: { code: "asc" },
    }),
  );
}

export async function createDepartment(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "hr.manage");
  const parsed = departmentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      if (v.parentId) await loadDepartment(tx, ctx, v.parentId, true);
      const d = await tx.department.create({
        data: {
          organizationId: ctx.organizationId,
          code: v.code,
          name: v.name,
          nameAr: v.nameAr ?? null,
          parentId: v.parentId,
        },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "department.created",
        entityType: "department",
        entityId: d.id,
        changes: { code: v.code, name: v.name, parentId: v.parentId },
      });
      return d;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw businessRuleViolation("DEPARTMENT_CODE_TAKEN", "This code is already used", {
        field: "code",
      });
    throw error;
  }
}

export async function setDepartmentArchived(ctx: TenantContext, id: string, archived: boolean) {
  assertPermission(ctx.grants, "hr.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const d = await loadDepartment(tx, ctx, id, false);
    if (archived) {
      const [people, children] = await inSequence([
        tx.employee.count({
          where: {
            organizationId: ctx.organizationId,
            departmentId: d.id,
            status: { not: "TERMINATED" },
          },
        }),
        tx.department.count({
          where: { organizationId: ctx.organizationId, parentId: d.id, archivedAt: null },
        }),
      ]);
      if (people > 0 || children > 0)
        throw businessRuleViolation(
          "DEPARTMENT_IN_USE",
          "Move its employees and sub-departments first",
        );
    }
    await tx.department.update({
      where: { id: d.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "department.archived" : "department.restored",
      entityType: "department",
      entityId: d.id,
      changes: {},
    });
  });
}

async function loadDepartment(tx: Tx, ctx: TenantContext, id: string, activeOnly: boolean) {
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) throw notFound("Department");
  const d = await tx.department.findFirst({
    where: { organizationId: ctx.organizationId, id: parsed.data },
  });
  if (!d || (activeOnly && d.archivedAt)) throw notFound("Department");
  return d;
}

// ─── Employees ───

const employeeSchema = z.object({
  number: z
    .string()
    .trim()
    .max(30, { error: "tooLong" })
    .regex(/^[A-Za-z0-9._-]*$/, { error: "invalid" })
    .optional()
    .transform((v) => (v ? v.toUpperCase() : null)),
  firstName: requiredText(80),
  lastName: requiredText(80),
  nameAr: optionalText(160),
  email: z
    .union([z.literal(""), z.email({ error: "invalidEmail" })])
    .optional()
    .transform((v) => (v ? v.toLowerCase() : null)),
  phone: z
    .string()
    .trim()
    .max(30, { error: "tooLong" })
    .regex(/^[+0-9 ()-]*$/, { error: "invalid" })
    .optional()
    .transform((v) => v || null),
  nationality: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z]{2})?$/, { error: "invalid" })
    .optional()
    .transform((v) => v || null),
  nationalId: z
    .string()
    .trim()
    .max(30, { error: "tooLong" })
    .optional()
    .transform((v) => v || null),
  jobTitle: requiredText(120),
  branchId: uuidSchema,
  departmentId: optionalUuid,
  managerId: optionalUuid,
  employmentType: z.enum(EMPLOYMENT_TYPES, { error: "invalidOption" }),
  hireDate: dateSchema,
  userId: optionalUuid,
});

const employeeInclude = {
  branch: { select: { id: true, code: true, name: true } },
  department: { select: { id: true, code: true, name: true } },
  manager: { select: { id: true, number: true, firstName: true, lastName: true } },
  user: { select: { id: true, email: true } },
} satisfies Prisma.EmployeeInclude;

export async function listEmployees(
  ctx: TenantContext,
  options: {
    q?: string;
    status?: string;
    branchId?: string;
    departmentId?: string;
    page?: number;
  } = {},
) {
  assertView(ctx);
  const page = Math.max(1, options.page ?? 1);
  const q = options.q?.trim();
  const status = z
    .enum(EMPLOYEE_STATUSES)
    .optional()
    .catch(undefined)
    .parse(options.status || undefined);
  const branchId = uuidSchema
    .optional()
    .catch(undefined)
    .parse(options.branchId || undefined);
  const departmentId = uuidSchema
    .optional()
    .catch(undefined)
    .parse(options.departmentId || undefined);
  const where: Prisma.EmployeeWhereInput = {
    organizationId: ctx.organizationId,
    AND: [
      viewFilter(ctx),
      status ? { status } : { status: { not: "TERMINATED" } },
      branchId ? { branchId } : {},
      departmentId ? { departmentId } : {},
      q
        ? {
            OR: [
              { firstName: { contains: q, mode: "insensitive" } },
              { lastName: { contains: q, mode: "insensitive" } },
              { nameAr: { contains: q, mode: "insensitive" } },
              { number: { contains: q, mode: "insensitive" } },
              { jobTitle: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.employee.count({ where }),
      tx.employee.findMany({
        where,
        include: employeeInclude,
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return {
      items: items.map((e) => mask(ctx, e)),
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
  });
}

/** Hide ID numbers from users who may not manage this employee's branch. */
function mask<T extends { branchId: string; nationalId: string | null }>(ctx: TenantContext, e: T) {
  return canManageBranch(ctx, e.branchId) ? e : { ...e, nationalId: null };
}

async function loadEmployee(tx: Tx, ctx: TenantContext, id: string) {
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) throw notFound("Employee");
  const e = await tx.employee.findFirst({
    where: { organizationId: ctx.organizationId, id: parsed.data, AND: [viewFilter(ctx)] },
  });
  if (!e) throw notFound("Employee");
  return e;
}

export async function getEmployee(ctx: TenantContext, id: string) {
  assertView(ctx);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const found = await loadEmployee(tx, ctx, id);
    const e = await tx.employee.findUniqueOrThrow({
      where: { id: found.id },
      include: {
        ...employeeInclude,
        documents: {
          orderBy: [{ expiresOn: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
        },
        reports: {
          where: { status: { not: "TERMINATED" } },
          select: { id: true, number: true, firstName: true, lastName: true, jobTitle: true },
          orderBy: { lastName: "asc" },
        },
      },
    });
    const manage = canManageBranch(ctx, e.branchId);
    const today = businessDate(ctx.timeZone);
    return {
      ...e,
      nationalId: manage ? e.nationalId : null,
      documents: e.documents.map((d) => ({
        ...d,
        number: manage ? d.number : null,
        state: documentState(d.expiresOn ? day(d.expiresOn) : null, today),
      })),
      can: { manage },
    };
  });
}

/** Next automatic employee number (EMP-00001), per organization. */
async function nextEmployeeNumber(tx: Tx, organizationId: string) {
  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "document_sequences" ("organization_id", "document_type", "year", "next_value")
    VALUES (${organizationId}::uuid, 'EMP', 0, 2)
    ON CONFLICT ("organization_id", "document_type", "year")
    DO UPDATE SET "next_value" = "document_sequences"."next_value" + 1
    RETURNING "next_value" - 1 AS value`;
  return `EMP-${String(rows[0].value).padStart(5, "0")}`;
}

/** Checks shared by create and update: branch, department, manager, linked account. */
async function checkLinks(
  tx: Tx,
  ctx: TenantContext,
  v: z.infer<typeof employeeSchema>,
  employeeId: string | null,
) {
  const branch = await tx.branch.findFirst({
    where: { organizationId: ctx.organizationId, id: v.branchId, archivedAt: null },
  });
  if (!branch)
    throw businessRuleViolation("EMPLOYEE_BRANCH_INVALID", "Branch not found", {
      field: "branchId",
    });
  if (v.departmentId) await loadDepartment(tx, ctx, v.departmentId, true);
  if (v.managerId) {
    const m = await tx.employee.findFirst({
      where: { organizationId: ctx.organizationId, id: v.managerId, status: { not: "TERMINATED" } },
    });
    if (!m)
      throw businessRuleViolation("EMPLOYEE_MANAGER_INVALID", "Choose an active manager", {
        field: "managerId",
      });
    if (employeeId) {
      const all = await tx.employee.findMany({
        where: { organizationId: ctx.organizationId },
        select: { id: true, managerId: true },
      });
      const managerOf = new Map(all.map((e) => [e.id, e.managerId]));
      if (createsReportingLoop(employeeId, v.managerId, managerOf))
        throw businessRuleViolation(
          "EMPLOYEE_MANAGER_LOOP",
          "This manager reports to the employee",
          { field: "managerId" },
        );
    }
  }
  if (v.userId) {
    const member = await tx.organizationMembership.findFirst({
      where: { organizationId: ctx.organizationId, userId: v.userId },
    });
    if (!member)
      throw businessRuleViolation(
        "EMPLOYEE_USER_NOT_MEMBER",
        "Choose a member of the organization",
        {
          field: "userId",
        },
      );
  }
}

const auditable = (v: z.infer<typeof employeeSchema>) => ({
  firstName: v.firstName,
  lastName: v.lastName,
  jobTitle: v.jobTitle,
  branchId: v.branchId,
  departmentId: v.departmentId,
  managerId: v.managerId,
  employmentType: v.employmentType,
  hireDate: v.hireDate,
  userId: v.userId,
  // Personal identifiers are never written to the audit log.
  nationalIdSet: v.nationalId !== null,
});

function uniqueError(error: unknown) {
  if (!isUniqueViolation(error)) return error;
  const target = String((error as { meta?: { target?: unknown } }).meta?.target ?? "");
  return target.includes("user")
    ? businessRuleViolation("EMPLOYEE_USER_TAKEN", "This account is linked to another employee", {
        field: "userId",
      })
    : businessRuleViolation("EMPLOYEE_NUMBER_TAKEN", "This employee number is already used", {
        field: "number",
      });
}

/**
 * Create an employee inside a caller's transaction (recruitment hires
 * through this, ADR-129). Unique-number and account clashes surface as the
 * database error; callers map them with `employeeUniqueError`.
 */
export async function createEmployeeInTx(tx: Tx, ctx: TenantContext, rawInput: unknown) {
  const parsed = employeeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  if (!canManageBranch(ctx, v.branchId)) throw forbidden();
  await checkLinks(tx, ctx, v, null);
  const e = await tx.employee.create({
    data: {
      organizationId: ctx.organizationId,
      number: v.number ?? (await nextEmployeeNumber(tx, ctx.organizationId)),
      firstName: v.firstName,
      lastName: v.lastName,
      nameAr: v.nameAr ?? null,
      email: v.email,
      phone: v.phone,
      nationality: v.nationality,
      nationalId: v.nationalId,
      jobTitle: v.jobTitle,
      branchId: v.branchId,
      departmentId: v.departmentId,
      managerId: v.managerId,
      employmentType: v.employmentType,
      hireDate: asDate(v.hireDate),
      userId: v.userId,
    },
  });
  await recordAudit(tx, actorOf(ctx), {
    action: "employee.created",
    entityType: "employee",
    entityId: e.id,
    changes: { number: e.number, ...auditable(v) },
  });
  return e;
}

export const employeeUniqueError = (error: unknown) => uniqueError(error);

export async function createEmployee(ctx: TenantContext, rawInput: unknown) {
  // Validate and check access before opening a transaction.
  const parsed = employeeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  if (!canManageBranch(ctx, parsed.data.branchId)) throw forbidden();
  try {
    return await withTenantTx(ctx.organizationId, (tx) => createEmployeeInTx(tx, ctx, rawInput));
  } catch (error) {
    throw uniqueError(error);
  }
}

export async function updateEmployee(ctx: TenantContext, id: string, rawInput: unknown) {
  const parsed = employeeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const e = await loadEmployee(tx, ctx, id);
      // Both the current and the new branch must be the user's to manage.
      if (!canManageBranch(ctx, e.branchId) || !canManageBranch(ctx, v.branchId)) throw forbidden();
      if (e.status === "TERMINATED")
        throw businessRuleViolation("EMPLOYEE_TERMINATED", "Rehire the employee before editing");
      if (v.managerId === e.id)
        throw businessRuleViolation(
          "EMPLOYEE_MANAGER_LOOP",
          "This manager reports to the employee",
          {
            field: "managerId",
          },
        );
      await checkLinks(tx, ctx, v, e.id);
      if (e.terminatedOn && asDate(v.hireDate) > e.terminatedOn)
        throw businessRuleViolation("EMPLOYEE_DATES", "Check the dates", { field: "hireDate" });
      const updated = await tx.employee.update({
        where: { id: e.id },
        data: {
          ...(v.number ? { number: v.number } : {}),
          firstName: v.firstName,
          lastName: v.lastName,
          nameAr: v.nameAr ?? null,
          email: v.email,
          phone: v.phone,
          nationality: v.nationality,
          nationalId: v.nationalId,
          jobTitle: v.jobTitle,
          branchId: v.branchId,
          departmentId: v.departmentId,
          managerId: v.managerId,
          employmentType: v.employmentType,
          hireDate: asDate(v.hireDate),
          userId: v.userId,
        },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "employee.updated",
        entityType: "employee",
        entityId: e.id,
        changes: { ...auditable(v), nationalIdChanged: v.nationalId !== e.nationalId },
      });
      return updated;
    });
  } catch (error) {
    throw uniqueError(error);
  }
}

const statusSchema = z
  .object({
    status: z.enum(EMPLOYEE_STATUSES, { error: "invalidOption" }),
    terminatedOn: optionalDate,
    reason: optionalText(300),
  })
  .refine((v) => v.status !== "TERMINATED" || v.terminatedOn, {
    error: "required",
    path: ["terminatedOn"],
  })
  .refine((v) => v.status !== "TERMINATED" || v.reason, { error: "required", path: ["reason"] });

/**
 * Active, on leave, or terminated (with a date and reason). Someone who still
 * manages people is not terminated until their reports are moved. Making a
 * terminated employee active again is a rehire: the termination is cleared.
 */
export async function changeEmployeeStatus(ctx: TenantContext, id: string, rawInput: unknown) {
  const parsed = statusSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployee(tx, ctx, id);
    if (!canManageBranch(ctx, e.branchId)) throw forbidden();
    if (v.status === "TERMINATED") {
      if (asDate(v.terminatedOn!) < e.hireDate)
        throw businessRuleViolation("EMPLOYEE_DATES", "Check the dates", { field: "terminatedOn" });
      const reports = await tx.employee.count({
        where: {
          organizationId: ctx.organizationId,
          managerId: e.id,
          status: { not: "TERMINATED" },
        },
      });
      if (reports > 0)
        throw businessRuleViolation(
          "EMPLOYEE_HAS_REPORTS",
          "Give this person's reports another manager first",
        );
    }
    await tx.employee.update({
      where: { id: e.id },
      data:
        v.status === "TERMINATED"
          ? { status: v.status, terminatedOn: asDate(v.terminatedOn!), terminationReason: v.reason }
          : { status: v.status, terminatedOn: null, terminationReason: null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "employee.status_changed",
      entityType: "employee",
      entityId: e.id,
      changes: {
        from: e.status,
        to: v.status,
        ...(v.status === "TERMINATED" ? { terminatedOn: v.terminatedOn, reason: v.reason } : {}),
      },
    });
  });
}

// ─── Documents ───

const documentSchema = z
  .object({
    type: z.enum(DOCUMENT_TYPES, { error: "invalidOption" }),
    number: z
      .string()
      .trim()
      .max(60, { error: "tooLong" })
      .optional()
      .transform((v) => v || null),
    issuedOn: optionalDate,
    expiresOn: optionalDate,
    note: optionalText(300),
  })
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn, {
    error: "invalid",
    path: ["expiresOn"],
  });

export async function addEmployeeDocument(
  ctx: TenantContext,
  employeeId: string,
  rawInput: unknown,
) {
  const parsed = documentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployee(tx, ctx, employeeId);
    if (!canManageBranch(ctx, e.branchId)) throw forbidden();
    const d = await tx.employeeDocument.create({
      data: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        type: v.type,
        number: v.number,
        issuedOn: v.issuedOn ? asDate(v.issuedOn) : null,
        expiresOn: v.expiresOn ? asDate(v.expiresOn) : null,
        note: v.note ?? null,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "employee_document.added",
      entityType: "employee",
      entityId: e.id,
      changes: { type: v.type, expiresOn: v.expiresOn },
    });
    return d;
  });
}

export async function removeEmployeeDocument(ctx: TenantContext, documentId: string) {
  const parsed = uuidSchema.safeParse(documentId);
  if (!parsed.success) throw notFound("Document");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const d = await tx.employeeDocument.findFirst({
      where: { organizationId: ctx.organizationId, id: parsed.data },
    });
    if (!d) throw notFound("Document");
    const e = await loadEmployee(tx, ctx, d.employeeId);
    if (!canManageBranch(ctx, e.branchId)) throw forbidden();
    await tx.employeeDocument.delete({ where: { id: d.id } });
    await recordAudit(tx, actorOf(ctx), {
      action: "employee_document.removed",
      entityType: "employee",
      entityId: e.id,
      changes: { type: d.type },
    });
    return { employeeId: e.id };
  });
}

// ─── Overview, org chart, form options ───

/** Real counts only: headcount by status, branch and department; new hires; document expiry. */
export async function hrOverview(ctx: TenantContext) {
  assertView(ctx);
  const today = businessDate(ctx.timeZone);
  const warnUntil = addDays(today, EXPIRY_WARNING_DAYS);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const scope = viewFilter(ctx);
    const [byStatus, current, newHires, documents] = await inSequence([
      tx.employee.groupBy({
        by: ["status"],
        where: { organizationId: ctx.organizationId, AND: [scope] },
        _count: { _all: true },
      }),
      tx.employee.findMany({
        where: { organizationId: ctx.organizationId, status: { not: "TERMINATED" }, AND: [scope] },
        select: {
          branch: { select: { id: true, code: true, name: true } },
          department: { select: { id: true, code: true, name: true } },
        },
      }),
      tx.employee.count({
        where: {
          organizationId: ctx.organizationId,
          hireDate: { gte: asDate(addDays(today, -30)) },
          AND: [scope],
        },
      }),
      tx.employeeDocument.findMany({
        where: {
          organizationId: ctx.organizationId,
          expiresOn: { lte: asDate(warnUntil) },
          employee: { status: { not: "TERMINATED" }, AND: [scope] },
        },
        include: {
          employee: { select: { id: true, number: true, firstName: true, lastName: true } },
        },
        orderBy: { expiresOn: "asc" },
        take: 50,
      }),
    ]);
    const count = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
    const tally = <K extends { id: string }>(key: (r: (typeof current)[number]) => K | null) => {
      const m = new Map<string, { item: K | null; count: number }>();
      for (const r of current) {
        const k = key(r);
        const id = k?.id ?? "";
        m.set(id, { item: k, count: (m.get(id)?.count ?? 0) + 1 });
      }
      return [...m.values()].sort((a, b) => b.count - a.count);
    };
    return {
      active: count("ACTIVE"),
      onLeave: count("ON_LEAVE"),
      terminated: count("TERMINATED"),
      newHires,
      byBranch: tally((r) => r.branch),
      byDepartment: tally((r) => r.department),
      documents: documents.map((d) => ({
        id: d.id,
        type: d.type,
        expiresOn: day(d.expiresOn!),
        state: documentState(day(d.expiresOn!), today),
        employee: d.employee,
      })),
    };
  });
}

export async function orgChart(ctx: TenantContext) {
  assertView(ctx);
  const people = await withTenantTx(ctx.organizationId, (tx) =>
    tx.employee.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { not: "TERMINATED" },
        AND: [viewFilter(ctx)],
      },
      select: {
        id: true,
        number: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        managerId: true,
        status: true,
        branch: { select: { code: true } },
      },
    }),
  );
  return orgTree(people, (p) => `${p.lastName} ${p.firstName}`);
}

/** Choices for the employee form: branches the user manages, departments, managers, members. */
export async function employeeFormOptions(ctx: TenantContext, excludeEmployeeId?: string) {
  if (!holdsAnyGrant(ctx.grants, "hr.manage")) throw forbidden();
  const scope = accessibleScope(ctx.grants, "hr.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [branches, departments, managers, members, linked] = await inSequence([
      tx.branch.findMany({
        where: {
          organizationId: ctx.organizationId,
          archivedAt: null,
          ...(scope.all ? {} : { id: { in: scope.branchIds } }),
        },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
      tx.department.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
      tx.employee.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: { not: "TERMINATED" },
          ...(excludeEmployeeId ? { id: { not: excludeEmployeeId } } : {}),
        },
        select: { id: true, number: true, firstName: true, lastName: true },
        orderBy: { lastName: "asc" },
      }),
      tx.organizationMembership.findMany({
        where: { organizationId: ctx.organizationId },
        select: { user: { select: { id: true, name: true, email: true } } },
      }),
      tx.employee.findMany({
        where: {
          organizationId: ctx.organizationId,
          userId: { not: null },
          ...(excludeEmployeeId ? { id: { not: excludeEmployeeId } } : {}),
        },
        select: { userId: true },
      }),
    ]);
    const taken = new Set(linked.map((l) => l.userId));
    return {
      branches,
      departments,
      managers,
      members: members.map((m) => m.user).filter((u) => !taken.has(u.id)),
    };
  });
}
