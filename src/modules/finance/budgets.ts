import "server-only";
import { z } from "zod";
import { decimalString } from "@/lib/decimal";
import { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import {
  accessibleScope,
  assertPermission,
  hasPermission,
  holdsAnyGrant,
} from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { forbidden, notFound, validationFailed } from "@/server/errors";
import { branchActualsInTx } from "./actuals";
import { BUDGET_ROWS, variance, withDerived, type BudgetRow, type Figures } from "./budget-rules";
import { EXPENSE_GROUPS } from "./expense-rules";

/**
 * Branch budgets and budget against actual (DECISIONS.md ADR-110). A budget
 * is set per branch, calendar month and line in the branch's company
 * currency; nothing is assumed. The sales line is the branch's sales target
 * (ADR-105), set on the targets page. Actuals come from branchActualsInTx.
 * Viewing needs `budgets.view` at the branch; setting needs
 * `budgets.manage`.
 */

const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? "0");
const BUDGET_LINES = ["COST_OF_SALES", ...EXPENSE_GROUPS] as const;
type BudgetLine = (typeof BUDGET_LINES)[number];
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

const setSchema = z.object({
  branchId: z.string().refine(isUuid, { error: "invalidOption" }),
  year: z.coerce.number().int().min(2000).max(2100),
  line: z.enum(BUDGET_LINES, { error: "invalidOption" }),
  months: z.record(
    z.string().regex(/^(0[1-9]|1[0-2])$/),
    z
      .string()
      .transform((v) => v.trim())
      .pipe(
        z.union([z.literal(""), decimalString({ maxScale: 2, min: "0", max: "999999999999" })]),
      ),
  ),
});

export const canSeeBudgets = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "budgets.view");

/** Branches the user may see budgets of. */
export async function budgetBranches(ctx: TenantContext) {
  if (!canSeeBudgets(ctx)) throw forbidden();
  const scope = accessibleScope(ctx.grants, "budgets.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(scope.all
          ? {}
          : {
              OR: [
                { id: { in: scope.branchIds } },
                { warehouses: { some: { id: { in: scope.warehouseIds } } } },
              ],
            }),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  );
}

async function loadBranch(tx: Tx, ctx: TenantContext, branchId: string) {
  if (!isUuid(branchId)) throw notFound("Branch");
  const b = await tx.branch.findFirst({
    where: { organizationId: ctx.organizationId, id: branchId },
    select: {
      id: true,
      code: true,
      name: true,
      timeZone: true,
      company: { select: { currency: true } },
    },
  });
  if (!b || !hasPermission(ctx.grants, "budgets.view", { branchId: b.id }))
    throw notFound("Branch");
  return b;
}

async function budgetsInTx(tx: Tx, ctx: TenantContext, branchId: string, year: number) {
  const range = {
    gte: new Date(`${year}-01-01T00:00:00Z`),
    lte: new Date(`${year}-12-01T00:00:00Z`),
  };
  const [lines, targets] = await Promise.all([
    tx.branchBudget.findMany({
      where: { organizationId: ctx.organizationId, branchId, month: range },
    }),
    tx.salesTarget.findMany({
      where: { organizationId: ctx.organizationId, branchId, month: range },
    }),
  ]);
  /** month "MM" → figures */
  const byMonth = new Map<string, Figures>();
  const put = (mm: string, key: keyof Figures, v: Decimal) => {
    const f = byMonth.get(mm) ?? {};
    f[key] = v;
    byMonth.set(mm, f);
  };
  for (const t of targets) put(t.month.toISOString().slice(5, 7), "SALES", dec(t.netAmount));
  for (const l of lines) put(l.month.toISOString().slice(5, 7), l.line, dec(l.amount));
  return byMonth;
}

/** A branch's budget for a year, month by month, with the derived rows. */
export async function budgetGrid(ctx: TenantContext, branchId: string, year: number) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await loadBranch(tx, ctx, branchId);
    const byMonth = await budgetsInTx(tx, ctx, branch.id, year);
    return {
      branch,
      year,
      currency: branch.company.currency,
      months: MONTHS.map((mm) => ({ month: mm, rows: withDerived(byMonth.get(mm) ?? {}) })),
      canManage: hasPermission(ctx.grants, "budgets.manage"),
      canSetSales: hasPermission(ctx.grants, "sales.targets.manage"),
    };
  });
}

/** Set (or clear) one budget line for the twelve months of a year. */
export async function setBudgetLine(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "budgets.manage");
  const parsed = setSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { branchId, year, line, months } = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await loadBranch(tx, ctx, branchId);
    const changes: Record<string, string> = {};
    for (const [mm, value] of Object.entries(months)) {
      const key = {
        organizationId: ctx.organizationId,
        branchId: branch.id,
        month: new Date(`${year}-${mm}-01T00:00:00Z`),
        line: line as BudgetLine,
      };
      if (value === "") {
        const gone = await tx.branchBudget.deleteMany({ where: key });
        if (gone.count) changes[mm] = "";
        continue;
      }
      await tx.branchBudget.upsert({
        where: { organizationId_branchId_month_line: key },
        create: {
          ...key,
          amount: value,
          currency: branch.company.currency,
          updatedByUserId: ctx.userId,
        },
        update: { amount: value, currency: branch.company.currency, updatedByUserId: ctx.userId },
      });
      changes[mm] = value;
    }
    await recordAudit(tx, actorOf(ctx), {
      action: "budget.set",
      entityType: "branch",
      entityId: branch.id,
      changes: { year, line, months: changes },
    });
  });
}

/**
 * Budget against actual for a branch and year: every row month by month and
 * year to date — up to the current month in the current year, the whole
 * year for past years, nothing for future ones.
 */
export async function budgetVsActual(ctx: TenantContext, branchId: string, year: number) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await loadBranch(tx, ctx, branchId);
    const today = businessDate(branch.timeZone ?? ctx.timeZone);
    const thisYear = Number(today.slice(0, 4));
    const lastMonth = year < thisYear ? 12 : year > thisYear ? 0 : Number(today.slice(5, 7));
    const budgets = await budgetsInTx(tx, ctx, branch.id, year);
    const actualMap =
      (await branchActualsInTx(tx, ctx, [branch.id], `${year}-01-01`, `${year}-12-31`)).get(
        branch.id,
      ) ?? new Map();
    // Actuals: a month without a figure is zero; up to the last month only.
    const actualOf = (mm: string) => {
      const f: Figures = { ...(actualMap.get(`${year}-${mm}`) ?? {}) };
      if (Number(mm) <= lastMonth) {
        f.SALES ??= new Decimal(0);
        f.COST_OF_SALES ??= new Decimal(0);
        for (const g of EXPENSE_GROUPS) f[g] ??= new Decimal(0);
      }
      return f;
    };
    const months = MONTHS.map((mm) => {
      const budget = withDerived(budgets.get(mm) ?? {});
      const actual = withDerived(actualOf(mm));
      return { month: mm, budget, actual, closed: Number(mm) <= lastMonth };
    });
    // Year to date: sums over the elapsed months; a row has a budget when any month has one.
    const ytd = (pick: "budget" | "actual") => {
      const sum = {} as Record<BudgetRow, Decimal | null>;
      for (const row of BUDGET_ROWS) {
        const values = months.filter((m) => m.closed).map((m) => m[pick][row]);
        sum[row] = values.some((v) => v !== null)
          ? values.reduce<Decimal>((a, v) => a.plus(v ?? 0), new Decimal(0))
          : null;
      }
      return sum;
    };
    const ytdBudget = ytd("budget");
    const ytdActual = ytd("actual");
    return {
      branch,
      year,
      lastMonth,
      currency: branch.company.currency,
      months,
      rows: BUDGET_ROWS.map((row) => ({
        row,
        ytdBudget: ytdBudget[row],
        ytdActual: ytdActual[row],
        ytdVariance: variance(row, ytdBudget[row], ytdActual[row] ?? 0),
        yearBudget: months.reduce<Decimal | null>(
          (a, m) => (m.budget[row] === null ? a : (a ?? new Decimal(0)).plus(m.budget[row]!)),
          null,
        ),
      })),
    };
  });
}
