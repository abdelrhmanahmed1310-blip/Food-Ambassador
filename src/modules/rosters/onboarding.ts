import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { isCalendarDate } from "@/lib/dates";
import { accessibleScope, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { canViewHr } from "@/modules/hr/service";
import { businessDate } from "@/modules/inventory/rules";
import { codeSchema, optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import { dueFrom } from "./rules";

/**
 * Onboarding checklists (DECISIONS.md ADR-128): templates of tasks for HR,
 * the line manager or the new hire, each due so many days from the start.
 * Starting one copies its tasks for the employee; whoever a task is for
 * ticks it (HR may tick any), and the checklist completes with the last.
 */

export const ONBOARDING_ASSIGNEES = ["HR", "MANAGER", "EMPLOYEE"] as const;
type Assignee = (typeof ONBOARDING_ASSIGNEES)[number];

const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const managesAll = (ctx: TenantContext) => accessibleScope(ctx.grants, "hr.manage").all;
const canManageBranch = (ctx: TenantContext, branchId: string) =>
  hasPermission(ctx.grants, "hr.manage", { branchId });

function viewFilter(ctx: TenantContext): Prisma.EmployeeWhereInput {
  const v = accessibleScope(ctx.grants, "hr.view");
  const m = accessibleScope(ctx.grants, "hr.manage");
  if (v.all || m.all) return {};
  return { branchId: { in: [...v.branchIds, ...m.branchIds] } };
}

// ─── Templates ───

export async function listOnboardingTemplates(ctx: TenantContext) {
  if (!canViewHr(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.onboardingTemplate.findMany({
      where: { organizationId: ctx.organizationId },
      include: { tasks: { orderBy: { position: "asc" } } },
      orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { code: "asc" }],
    }),
  );
}

export async function createOnboardingTemplate(ctx: TenantContext, rawInput: unknown) {
  if (!managesAll(ctx)) throw forbidden();
  const parsed = z.object({ code: codeSchema, name: requiredText(120) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const clash = await tx.onboardingTemplate.findFirst({
      where: { organizationId: ctx.organizationId, code: v.code },
      select: { id: true },
    });
    if (clash) throw conflict("A checklist with this code already exists", { field: "code" });
    const t = await tx.onboardingTemplate.create({
      data: { organizationId: ctx.organizationId, ...v },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "onboarding_template.created",
      entityType: "onboarding_template",
      entityId: t.id,
      changes: v,
    });
    return t;
  });
}

async function loadTemplate(tx: Tx, ctx: TenantContext, templateId: string) {
  const id = uuidSchema.safeParse(templateId);
  if (!id.success) throw notFound("Checklist");
  const t = await tx.onboardingTemplate.findFirst({
    where: { organizationId: ctx.organizationId, id: id.data },
    include: { tasks: { orderBy: { position: "asc" } } },
  });
  if (!t) throw notFound("Checklist");
  return t;
}

const taskSchema = z.object({
  title: requiredText(200),
  dueDays: z.coerce.number({ error: "invalidNumber" }).int().min(-30).max(365),
  assignee: z.enum(ONBOARDING_ASSIGNEES, { error: "invalidOption" }),
});

/** Add a task; checklists already started keep the tasks they were started with. */
export async function addTemplateTask(ctx: TenantContext, templateId: string, rawInput: unknown) {
  if (!managesAll(ctx)) throw forbidden();
  const parsed = taskSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await loadTemplate(tx, ctx, templateId);
    if (t.archivedAt)
      throw businessRuleViolation("ONBOARDING_ARCHIVED", "This checklist is archived");
    await tx.onboardingTemplateTask.create({
      data: {
        organizationId: ctx.organizationId,
        templateId: t.id,
        position: (t.tasks.at(-1)?.position ?? 0) + 1,
        ...parsed.data,
      },
    });
  });
}

export async function removeTemplateTask(ctx: TenantContext, taskId: string) {
  if (!managesAll(ctx)) throw forbidden();
  const id = uuidSchema.safeParse(taskId);
  if (!id.success) throw notFound("Task");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const task = await tx.onboardingTemplateTask.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data },
    });
    if (!task) throw notFound("Task");
    await tx.onboardingTemplateTask.delete({ where: { id: task.id } });
    return { templateId: task.templateId };
  });
}

export async function setOnboardingTemplateArchived(
  ctx: TenantContext,
  templateId: string,
  archived: boolean,
) {
  if (!managesAll(ctx)) throw forbidden();
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await loadTemplate(tx, ctx, templateId);
    await tx.onboardingTemplate.update({
      where: { id: t.id },
      data: { archivedAt: archived ? new Date() : null },
    });
  });
}

// ─── Checklists ───

const startSchema = z.object({
  templateId: uuidSchema,
  startedOn: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || null)
    .refine((v) => v === null || isCalendarDate(v), { error: "invalidDate" }),
});

/** Start a checklist for an employee, from their hire date unless another start is given. */
export async function startOnboarding(ctx: TenantContext, employeeId: string, rawInput: unknown) {
  const parsed = startSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const id = uuidSchema.safeParse(employeeId);
  if (!id.success) throw notFound("Employee");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await tx.employee.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data, AND: [viewFilter(ctx)] },
      select: { id: true, branchId: true, hireDate: true, status: true },
    });
    if (!e) throw notFound("Employee");
    if (!canManageBranch(ctx, e.branchId)) throw forbidden();
    if (e.status === "TERMINATED")
      throw businessRuleViolation("ONBOARDING_TERMINATED", "This employee has left");
    const t = await loadTemplate(tx, ctx, parsed.data.templateId);
    if (t.archivedAt)
      throw businessRuleViolation("ONBOARDING_ARCHIVED", "This checklist is archived");
    if (t.tasks.length === 0)
      throw businessRuleViolation("ONBOARDING_NO_TASKS", "Add tasks to the checklist first");
    const open = await tx.onboardingChecklist.findFirst({
      where: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        templateId: t.id,
        completedAt: null,
        cancelledAt: null,
      },
      select: { id: true },
    });
    if (open) throw conflict("This checklist is already open for this employee");
    const startedOn = parsed.data.startedOn ?? iso(e.hireDate);
    const c = await tx.onboardingChecklist.create({
      data: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        templateId: t.id,
        startedOn: asDate(startedOn),
        createdByUserId: ctx.userId,
        tasks: {
          create: t.tasks.map((x) => ({
            position: x.position,
            title: x.title,
            dueOn: asDate(dueFrom(startedOn, x.dueDays)),
            assignee: x.assignee,
          })),
        },
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "onboarding.started",
      entityType: "employee",
      entityId: e.id,
      changes: { checklist: t.code, startedOn },
    });
    return c;
  });
}

type Role = { hr: boolean; manager: boolean; employee: boolean };

/** How the user relates to a checklist's employee. */
async function roleFor(
  tx: Tx,
  ctx: TenantContext,
  employeeId: string,
): Promise<Role & { view: boolean }> {
  const e = await tx.employee.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, id: employeeId },
    select: { branchId: true, userId: true, manager: { select: { userId: true } } },
  });
  const hrView =
    canViewHr(ctx) &&
    Boolean(
      await tx.employee.findFirst({
        where: { organizationId: ctx.organizationId, id: employeeId, AND: [viewFilter(ctx)] },
        select: { id: true },
      }),
    );
  const role = {
    hr: canManageBranch(ctx, e.branchId),
    manager: Boolean(e.manager?.userId && e.manager.userId === ctx.userId),
    employee: Boolean(e.userId && e.userId === ctx.userId),
  };
  return { ...role, view: hrView || role.manager || role.employee };
}

const mayTick = (r: Role, a: Assignee) =>
  r.hr || (a === "MANAGER" && r.manager) || (a === "EMPLOYEE" && r.employee);

async function loadChecklist(tx: Tx, ctx: TenantContext, checklistId: string) {
  const id = uuidSchema.safeParse(checklistId);
  if (!id.success) throw notFound("Checklist");
  const c = await tx.onboardingChecklist.findFirst({
    where: { organizationId: ctx.organizationId, id: id.data },
    include: {
      template: { select: { code: true, name: true } },
      employee: {
        select: { id: true, number: true, firstName: true, lastName: true, jobTitle: true },
      },
      tasks: { orderBy: { position: "asc" } },
    },
  });
  if (!c) throw notFound("Checklist");
  return c;
}

export async function getChecklist(ctx: TenantContext, checklistId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadChecklist(tx, ctx, checklistId);
    const role = await roleFor(tx, ctx, c.employeeId);
    if (!role.view) throw notFound("Checklist");
    const today = businessDate(ctx.timeZone);
    const open = !c.completedAt && !c.cancelledAt;
    return {
      checklist: c,
      tasks: c.tasks.map((t) => ({
        ...t,
        overdue: open && !t.doneAt && iso(t.dueOn) < today,
        mayTick: open && mayTick(role, t.assignee),
      })),
      can: { cancel: open && role.hr },
    };
  });
}

export async function setOnboardingTask(
  ctx: TenantContext,
  taskId: string,
  rawInput: { done: boolean; note?: unknown },
) {
  const id = uuidSchema.safeParse(taskId);
  if (!id.success) throw notFound("Task");
  const note = optionalText(300).safeParse(rawInput.note ?? "");
  if (!note.success) throw validationFailed(note.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const task = await tx.onboardingTask.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data },
      include: { checklist: true },
    });
    if (!task) throw notFound("Task");
    const role = await roleFor(tx, ctx, task.checklist.employeeId);
    if (!role.view) throw notFound("Task");
    if (!mayTick(role, task.assignee)) throw forbidden();
    if (task.checklist.completedAt || task.checklist.cancelledAt)
      throw businessRuleViolation("ONBOARDING_CLOSED", "This checklist is closed");
    await tx.onboardingTask.update({
      where: { id: task.id },
      data: rawInput.done
        ? { doneAt: new Date(), doneByUserId: ctx.userId, note: note.data }
        : { doneAt: null, doneByUserId: null, note: null },
    });
    const left = await tx.onboardingTask.count({
      where: { organizationId: ctx.organizationId, checklistId: task.checklistId, doneAt: null },
    });
    if (left === 0) {
      await tx.onboardingChecklist.update({
        where: { id: task.checklistId },
        data: { completedAt: new Date() },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "onboarding.completed",
        entityType: "employee",
        entityId: task.checklist.employeeId,
        changes: { checklistId: task.checklistId },
      });
    }
    return { checklistId: task.checklistId, completed: left === 0 };
  });
}

export async function cancelOnboarding(ctx: TenantContext, checklistId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(200) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadChecklist(tx, ctx, checklistId);
    const role = await roleFor(tx, ctx, c.employeeId);
    if (!role.view) throw notFound("Checklist");
    if (!role.hr) throw forbidden();
    if (c.completedAt || c.cancelledAt)
      throw businessRuleViolation("ONBOARDING_CLOSED", "This checklist is closed");
    await tx.onboardingChecklist.update({
      where: { id: c.id },
      data: { cancelledAt: new Date(), cancelReason: parsed.data.reason },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "onboarding.cancelled",
      entityType: "employee",
      entityId: c.employeeId,
      changes: { checklistId: c.id, reason: parsed.data.reason },
    });
  });
}

const progressOf = (tasks: Array<{ doneAt: Date | null; dueOn: Date }>, today: string) => ({
  total: tasks.length,
  done: tasks.filter((t) => t.doneAt).length,
  overdue: tasks.filter((t) => !t.doneAt && iso(t.dueOn) < today).length,
  nextDue:
    tasks
      .filter((t) => !t.doneAt)
      .map((t) => iso(t.dueOn))
      .sort()[0] ?? null,
});

/** Open checklists for the employees the user may see, with progress. */
export async function onboardingBoard(ctx: TenantContext) {
  if (!canViewHr(ctx)) throw forbidden();
  const today = businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const lists = await tx.onboardingChecklist.findMany({
      where: {
        organizationId: ctx.organizationId,
        completedAt: null,
        cancelledAt: null,
        employee: viewFilter(ctx),
      },
      include: {
        template: { select: { code: true, name: true } },
        employee: {
          select: {
            id: true,
            number: true,
            firstName: true,
            lastName: true,
            branch: { select: { code: true } },
          },
        },
        tasks: { select: { doneAt: true, dueOn: true } },
      },
      orderBy: { startedOn: "desc" },
    });
    return lists.map(({ tasks, ...c }) => ({ ...c, progress: progressOf(tasks, today) }));
  });
}

/** An employee's checklists, and the templates HR may start (employee page). */
export async function employeeOnboarding(ctx: TenantContext, employeeId: string) {
  if (!canViewHr(ctx)) throw forbidden();
  const id = uuidSchema.safeParse(employeeId);
  if (!id.success) throw notFound("Employee");
  const today = businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await tx.employee.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data, AND: [viewFilter(ctx)] },
      select: { id: true, branchId: true, status: true },
    });
    if (!e) throw notFound("Employee");
    const [lists, templates] = await Promise.all([
      tx.onboardingChecklist.findMany({
        where: { organizationId: ctx.organizationId, employeeId: e.id },
        include: {
          template: { select: { code: true, name: true } },
          tasks: { select: { doneAt: true, dueOn: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      tx.onboardingTemplate.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null, tasks: { some: {} } },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
    ]);
    return {
      checklists: lists.map(({ tasks, ...c }) => ({ ...c, progress: progressOf(tasks, today) })),
      templates,
      can: { start: canManageBranch(ctx, e.branchId) && e.status !== "TERMINATED" },
    };
  });
}

/** Where the user is to tick tasks: their own checklists and their reports'. */
function myTasksWhere(ctx: TenantContext): Prisma.OnboardingTaskWhereInput {
  return {
    organizationId: ctx.organizationId,
    doneAt: null,
    checklist: { completedAt: null, cancelledAt: null },
    OR: [
      { assignee: "EMPLOYEE", checklist: { employee: { userId: ctx.userId } } },
      { assignee: "MANAGER", checklist: { employee: { manager: { userId: ctx.userId } } } },
    ],
  };
}

/** Open checklists the signed-in user takes part in: their own, and their reports'. */
export async function myOnboarding(ctx: TenantContext) {
  const today = businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const lists = await tx.onboardingChecklist.findMany({
      where: {
        organizationId: ctx.organizationId,
        completedAt: null,
        cancelledAt: null,
        OR: [
          { employee: { userId: ctx.userId } },
          { employee: { manager: { userId: ctx.userId } } },
        ],
      },
      include: {
        template: { select: { name: true } },
        employee: { select: { firstName: true, lastName: true, userId: true } },
        tasks: { select: { doneAt: true, dueOn: true } },
      },
      orderBy: { startedOn: "asc" },
    });
    const mine = await tx.onboardingTask.count({ where: myTasksWhere(ctx) });
    return {
      tasksToDo: mine,
      checklists: lists.map(({ tasks, employee, ...c }) => ({
        ...c,
        employee: { firstName: employee.firstName, lastName: employee.lastName },
        own: employee.userId === ctx.userId,
        progress: progressOf(tasks, today),
      })),
    };
  });
}

/** For the needs-attention list: overdue tasks HR manages, and tasks waiting on the user. */
export async function onboardingAttentionInTx(tx: Tx, ctx: TenantContext) {
  const today = asDate(businessDate(ctx.timeZone));
  const scope = accessibleScope(ctx.grants, "hr.manage");
  const overdue =
    scope.all || scope.branchIds.length
      ? await tx.onboardingTask.count({
          where: {
            organizationId: ctx.organizationId,
            doneAt: null,
            dueOn: { lt: today },
            checklist: {
              completedAt: null,
              cancelledAt: null,
              ...(scope.all ? {} : { employee: { branchId: { in: scope.branchIds } } }),
            },
          },
        })
      : 0;
  const mine = await tx.onboardingTask.count({ where: myTasksWhere(ctx) });
  return { overdue, mine };
}
