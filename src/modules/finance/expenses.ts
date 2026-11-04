import "server-only";
import { z } from "zod";
import { toCsv } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import {
  accessibleScope,
  assertPermission,
  hasPermission,
  holdsAnyGrant,
} from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import {
  codeSchema,
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
import { EXPENSE_GROUPS, expenseGross, totalsByGroup } from "./expense-rules";

/**
 * Cost centres, expense categories and operating expenses (DECISIONS.md
 * ADR-109). Categories are the organization's own (none are assumed), each
 * placed in a P&L group. An expense belongs to a branch, is in that branch's
 * company currency, and is never edited: a mistake is reversed with a reason
 * and entered again. Setting up categories and cost centres needs
 * `expenses.manage` organization-wide; recording needs it at the branch;
 * viewing needs `expenses.view` at the branch.
 */

const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? "0");
const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

const centreSchema = z.object({
  code: codeSchema,
  name: requiredText(120),
  branchId: optionalUuidSchema,
});
const categorySchema = z.object({
  code: codeSchema,
  name: requiredText(120),
  nameAr: optionalText(120),
  group: z.enum(EXPENSE_GROUPS, { error: "invalidOption" }),
});
const expenseSchema = z.object({
  branchId: uuidSchema,
  categoryId: uuidSchema,
  costCentreId: optionalUuidSchema,
  supplierId: optionalUuidSchema,
  expenseDate: z
    .string({ error: "required" })
    .trim()
    .refine(isCalendarDate, { error: "invalidDate" }),
  description: requiredText(500),
  reference: optionalText(80),
  netAmount: decimalString({ maxScale: 4, min: "0.0001", max: "999999999999" }),
  taxAmount: z
    .string()
    .optional()
    .transform(blank)
    .pipe(decimalString({ maxScale: 4, min: "0", max: "999999999999" }).optional()),
});
const reverseSchema = z.object({ reason: requiredText(500) });
const listSchema = z.object({
  from: z.string().refine(isCalendarDate).optional().catch(undefined),
  to: z.string().refine(isCalendarDate).optional().catch(undefined),
  branchId: z.string().refine(isUuid).optional().catch(undefined),
  categoryId: z.string().refine(isUuid).optional().catch(undefined),
});

export const canSeeExpenses = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "expenses.view");

function codeConflict(error: unknown): never {
  if (isUniqueViolation(error)) throw conflict("codeTaken");
  throw error;
}

// ─── Set-up ───

export async function createCostCentre(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "expenses.manage");
  const parsed = centreSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      if (input.branchId) {
        const b = await tx.branch.findFirst({
          where: { organizationId: ctx.organizationId, id: input.branchId },
          select: { id: true },
        });
        if (!b) throw notFound("Branch");
      }
      const c = await tx.costCentre.create({
        data: {
          organizationId: ctx.organizationId,
          code: input.code,
          name: input.name,
          branchId: input.branchId ?? null,
          createdByUserId: ctx.userId,
        },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "cost_centre.created",
        entityType: "cost_centre",
        entityId: c.id,
        changes: input,
      });
      return c;
    });
  } catch (error) {
    codeConflict(error);
  }
}

export async function createExpenseCategory(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "expenses.manage");
  const parsed = categorySchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const c = await tx.expenseCategory.create({
        data: {
          organizationId: ctx.organizationId,
          code: input.code,
          name: input.name,
          nameAr: input.nameAr ?? null,
          group: input.group,
          createdByUserId: ctx.userId,
        },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "expense_category.created",
        entityType: "expense_category",
        entityId: c.id,
        changes: input,
      });
      return c;
    });
  } catch (error) {
    codeConflict(error);
  }
}

export async function setSetupArchived(
  ctx: TenantContext,
  kind: "COST_CENTRE" | "CATEGORY",
  id: string,
  archived: boolean,
) {
  assertPermission(ctx.grants, "expenses.manage");
  if (!isUuid(id)) throw notFound(kind === "CATEGORY" ? "Category" : "Cost centre");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const where = { organizationId: ctx.organizationId, id };
    const data = { archivedAt: archived ? new Date() : null };
    const n =
      kind === "CATEGORY"
        ? await tx.expenseCategory.updateMany({ where, data })
        : await tx.costCentre.updateMany({ where, data });
    if (n.count === 0) throw notFound(kind === "CATEGORY" ? "Category" : "Cost centre");
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "expense_setup.archived" : "expense_setup.restored",
      entityType: kind === "CATEGORY" ? "expense_category" : "cost_centre",
      entityId: id,
      changes: {},
    });
  });
}

export async function expenseSetup(ctx: TenantContext) {
  if (!canSeeExpenses(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [categories, centres] = await Promise.all([
      tx.expenseCategory.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { code: "asc" }],
      }),
      tx.costCentre.findMany({
        where: { organizationId: ctx.organizationId },
        include: { branch: { select: { code: true, name: true } } },
        orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { code: "asc" }],
      }),
    ]);
    return { categories, centres, canManage: hasPermission(ctx.grants, "expenses.manage") };
  });
}

// ─── Expenses ───

async function branchFor(tx: Tx, ctx: TenantContext, branchId: string) {
  const b = await tx.branch.findFirst({
    where: { organizationId: ctx.organizationId, id: branchId },
    select: {
      id: true,
      code: true,
      timeZone: true,
      archivedAt: true,
      company: { select: { currency: true } },
    },
  });
  if (!b || !hasPermission(ctx.grants, "expenses.view", { branchId: b.id }))
    throw notFound("Branch");
  return b;
}

/** Record an operating expense at a branch. */
export async function recordExpense(ctx: TenantContext, rawInput: unknown) {
  const parsed = expenseSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await branchFor(tx, ctx, input.branchId);
    assertPermission(ctx.grants, "expenses.manage", { branchId: branch.id });
    if (branch.archivedAt)
      throw businessRuleViolation("BRANCH_ARCHIVED", "The branch is archived", {
        field: "branchId",
      });
    const today = businessDate(branch.timeZone ?? ctx.timeZone);
    if (input.expenseDate > today)
      throw businessRuleViolation("DATE_IN_FUTURE", "The date is in the future", {
        field: "expenseDate",
      });
    const category = await tx.expenseCategory.findFirst({
      where: { organizationId: ctx.organizationId, id: input.categoryId, archivedAt: null },
      select: { id: true },
    });
    if (!category) throw notFound("Category");
    if (input.costCentreId) {
      const c = await tx.costCentre.findFirst({
        where: { organizationId: ctx.organizationId, id: input.costCentreId, archivedAt: null },
        select: { branchId: true },
      });
      if (!c) throw notFound("Cost centre");
      if (c.branchId && c.branchId !== branch.id)
        throw businessRuleViolation(
          "COST_CENTRE_OTHER_BRANCH",
          "The cost centre belongs to another branch",
          { field: "costCentreId" },
        );
    }
    if (input.supplierId) {
      const s = await tx.supplier.findFirst({
        where: { organizationId: ctx.organizationId, id: input.supplierId },
        select: { id: true },
      });
      if (!s) throw notFound("Supplier");
    }
    const tax = input.taxAmount ?? "0";
    const number = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      "EXP",
      Number(input.expenseDate.slice(0, 4)),
    );
    const e = await tx.expense.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        branchId: branch.id,
        categoryId: category.id,
        costCentreId: input.costCentreId ?? null,
        supplierId: input.supplierId ?? null,
        expenseDate: new Date(`${input.expenseDate}T00:00:00Z`),
        description: input.description,
        reference: input.reference ?? null,
        netAmount: input.netAmount,
        taxAmount: tax,
        grossAmount: expenseGross(input.netAmount, tax).toFixed(4),
        currency: branch.company.currency,
        createdByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "expense.recorded",
      entityType: "expense",
      entityId: e.id,
      changes: { number, ...input, taxAmount: tax, currency: branch.company.currency },
    });
    return e;
  });
}

export async function reverseExpense(ctx: TenantContext, expenseId: string, rawInput: unknown) {
  const parsed = reverseSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  if (!isUuid(expenseId)) throw notFound("Expense");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const e = await tx.expense.findFirst({
      where: { organizationId: ctx.organizationId, id: expenseId },
      select: { id: true, number: true, status: true, branchId: true },
    });
    if (!e || !hasPermission(ctx.grants, "expenses.view", { branchId: e.branchId }))
      throw notFound("Expense");
    assertPermission(ctx.grants, "expenses.manage", { branchId: e.branchId });
    if (e.status !== "POSTED")
      throw businessRuleViolation("EXPENSE_REVERSED", "The expense was already reversed");
    await tx.expense.update({
      where: { id: e.id },
      data: {
        status: "REVERSED",
        reversedAt: new Date(),
        reversedByUserId: ctx.userId,
        reverseReason: parsed.data.reason,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "expense.reversed",
      entityType: "expense",
      entityId: e.id,
      changes: { number: e.number, reason: parsed.data.reason },
    });
  });
}

function scopeWhere(ctx: TenantContext) {
  const scope = accessibleScope(ctx.grants, "expenses.view");
  if (scope.all) return {};
  return {
    OR: [
      { branchId: { in: scope.branchIds } },
      { branch: { warehouses: { some: { id: { in: scope.warehouseIds } } } } },
    ],
  };
}

/** Expenses with filters, newest first, and posted totals per currency and P&L group. */
export async function listExpenses(ctx: TenantContext, rawFilters: unknown = {}) {
  if (!canSeeExpenses(ctx)) throw forbidden();
  const f = listSchema.parse(rawFilters ?? {});
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.expense.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...scopeWhere(ctx),
        ...(f.branchId ? { branchId: f.branchId } : {}),
        ...(f.categoryId ? { categoryId: f.categoryId } : {}),
        ...(f.from || f.to
          ? {
              expenseDate: {
                ...(f.from ? { gte: new Date(`${f.from}T00:00:00Z`) } : {}),
                ...(f.to ? { lte: new Date(`${f.to}T00:00:00Z`) } : {}),
              },
            }
          : {}),
      },
      include: {
        branch: { select: { code: true, name: true } },
        category: { select: { code: true, name: true, nameAr: true, group: true } },
        costCentre: { select: { code: true, name: true } },
        supplier: { select: { code: true, name: true } },
      },
      orderBy: [{ expenseDate: "desc" }, { number: "desc" }],
      take: 500,
    });
    const currencies = [...new Set(rows.map((r) => r.currency))].sort();
    return {
      filters: f,
      rows,
      totals: currencies.map((currency) => {
        const mine = rows.filter((r) => r.currency === currency);
        return {
          currency,
          net: mine
            .filter((r) => r.status === "POSTED")
            .reduce((a, r) => a.plus(dec(r.netAmount)), new Decimal(0)),
          groups: totalsByGroup(
            mine.map((r) => ({ group: r.category.group, net: dec(r.netAmount), status: r.status })),
          ),
        };
      }),
    };
  });
}

export async function getExpense(ctx: TenantContext, expenseId: string) {
  if (!isUuid(expenseId)) throw notFound("Expense");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await tx.expense.findFirst({
      where: { organizationId: ctx.organizationId, id: expenseId },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        category: { select: { code: true, name: true, nameAr: true, group: true } },
        costCentre: { select: { code: true, name: true } },
        supplier: { select: { id: true, code: true, name: true } },
      },
    });
    if (!e || !hasPermission(ctx.grants, "expenses.view", { branchId: e.branchId }))
      throw notFound("Expense");
    const users = await tx.user.findMany({
      where: {
        id: { in: [e.createdByUserId, e.reversedByUserId].filter((v): v is string => !!v) },
      },
      select: { id: true, name: true },
    });
    const name = (id: string | null) => users.find((u) => u.id === id)?.name ?? null;
    return {
      ...e,
      createdBy: name(e.createdByUserId),
      reversedBy: name(e.reversedByUserId),
      canReverse:
        e.status === "POSTED" &&
        hasPermission(ctx.grants, "expenses.manage", { branchId: e.branchId }),
    };
  });
}

/** Branches, categories, cost centres and suppliers for the expense form. */
export async function expenseFormOptions(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const scope = accessibleScope(ctx.grants, "expenses.manage");
    const [branches, categories, centres, suppliers] = await Promise.all([
      tx.branch.findMany({
        where: {
          organizationId: ctx.organizationId,
          archivedAt: null,
          ...(scope.all ? {} : { id: { in: scope.branchIds } }),
        },
        select: { id: true, code: true, name: true, company: { select: { currency: true } } },
        orderBy: { code: "asc" },
      }),
      tx.expenseCategory.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, code: true, name: true, nameAr: true, group: true },
        orderBy: { code: "asc" },
      }),
      tx.costCentre.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, code: true, name: true, branchId: true },
        orderBy: { code: "asc" },
      }),
      hasPermission(ctx.grants, "suppliers.view")
        ? tx.supplier.findMany({
            where: { organizationId: ctx.organizationId, archivedAt: null },
            select: { id: true, code: true, name: true },
            orderBy: { code: "asc" },
            take: 1000,
          })
        : Promise.resolve([]),
    ]);
    return { branches, categories, centres, suppliers };
  });
}

export async function exportExpensesCsv(ctx: TenantContext, rawFilters: unknown = {}) {
  const r = await listExpenses(ctx, rawFilters);
  return toCsv(
    [
      "number",
      "date",
      "branch",
      "category",
      "group",
      "cost centre",
      "supplier",
      "description",
      "reference",
      "net",
      "VAT",
      "gross",
      "currency",
      "status",
    ],
    r.rows.map((e) => [
      e.number,
      e.expenseDate.toISOString().slice(0, 10),
      e.branch.code,
      e.category.code,
      e.category.group,
      e.costCentre?.code ?? "",
      e.supplier?.code ?? "",
      e.description,
      e.reference ?? "",
      dec(e.netAmount).toFixed(2),
      dec(e.taxAmount).toFixed(2),
      dec(e.grossAmount).toFixed(2),
      e.currency,
      e.status,
    ]),
  );
}
