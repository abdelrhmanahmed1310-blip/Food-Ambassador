import "server-only";
import { z } from "zod";
import { toCsv } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { decryptSecret, encryptSecret, integrationKey } from "@/modules/integrations/crypto";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { ibanProblem } from "@/modules/procurement/compliance-rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import {
  ADJUSTMENT_CATEGORIES,
  APPLIES_TO,
  computeLine,
  paidDays,
  periodBounds,
  PRORATION_BASES,
  ruleApplies,
  unpaidDaysIn,
  type ProrationBasis,
} from "./rules";

/**
 * Payroll (DECISIONS.md ADR-123): dated salaries, contribution rules the
 * organization enters per company (nothing statutory is preset, Q-20),
 * monthly runs with adjustments, approval by someone other than the
 * preparer, payslips and a bank transfer file. Pay data is organization
 * level: `payroll.view`, `payroll.manage`, `payroll.approve`.
 */

const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? "0");
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const sealKey = () => {
  const env = getEnv();
  return integrationKey(env.INTEGRATION_ENCRYPTION_KEY, env.AUTH_SECRET);
};

export const canViewPayroll = (ctx: TenantContext) => hasPermission(ctx.grants, "payroll.view");
export const canManagePayroll = (ctx: TenantContext) => hasPermission(ctx.grants, "payroll.manage");

const money = (opts: { min?: string } = {}) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(decimalString({ maxScale: 4, min: opts.min ?? "0", max: "999999999" }));
const date = z.string().refine(isCalendarDate, { error: "invalidDate" });
const fraction = z
  .string()
  .transform((v) => v.trim())
  .pipe(decimalString({ maxScale: 4, min: "0", max: "100" }))
  .transform((v) => new Decimal(v).dividedBy(100).toFixed());
const code = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .refine((v) => /^[A-Z][A-Z0-9_]{0,19}$/.test(v), { error: "invalidCode" });

async function loadEmployee(tx: Tx, ctx: TenantContext, employeeId: string) {
  const e = await tx.employee.findFirst({
    where: { organizationId: ctx.organizationId, id: employeeId },
    select: {
      id: true,
      number: true,
      firstName: true,
      lastName: true,
      branch: { select: { company: { select: { id: true, currency: true } } } },
    },
  });
  if (!e) throw notFound("Employee");
  return e;
}

// ─── Settings ───

export async function getPayrollSettings(ctx: TenantContext) {
  assertPermission(ctx.grants, "payroll.view");
  return withTenantTx(ctx.organizationId, async (tx) => ({
    prorationBasis:
      (await tx.payrollSettings.findUnique({ where: { organizationId: ctx.organizationId } }))
        ?.prorationBasis ?? null,
  }));
}

export async function setProrationBasis(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "payroll.manage");
  const parsed = z.object({ prorationBasis: z.enum(PRORATION_BASES) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { prorationBasis } = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.payrollSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, prorationBasis, updatedByUserId: ctx.userId },
      update: { prorationBasis, updatedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "payroll.settings_updated",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: { prorationBasis },
    });
  });
}

// ─── Salaries and bank accounts ───

const itemSchema = z.object({
  code,
  name: requiredText(60),
  amount: money(),
  inContributionBase: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
});

const salarySchema = z.object({
  effectiveFrom: date,
  basic: money(),
  payMethod: z.enum(["BANK", "CASH"]),
  note: optionalText(200),
  items: z
    .array(z.unknown())
    .default([])
    // Empty rows of the form are left out.
    .transform((rows) =>
      rows.filter(
        (r) =>
          r &&
          typeof r === "object" &&
          Object.values(r).some((v) => typeof v === "string" && v.trim()),
      ),
    )
    .pipe(z.array(itemSchema).max(12)),
});

/** A new salary from a date; earlier records stay as they were. */
export async function setSalary(ctx: TenantContext, employeeId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "payroll.manage");
  const parsed = salarySchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  const codes = input.items.map((i) => i.code);
  if (new Set(codes).size !== codes.length || codes.includes("BASIC"))
    throw businessRuleViolation("SALARY_ITEM_DUPLICATE", "Each allowance needs its own code");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployee(tx, ctx, employeeId);
    // A month already approved cannot be paid differently.
    const settled = await tx.payrollLine.findFirst({
      where: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        run: {
          status: { in: ["APPROVED", "PAID"] },
          period: { gte: asDate(`${input.effectiveFrom.slice(0, 7)}-01`) },
        },
      },
      select: { id: true },
    });
    if (settled)
      throw businessRuleViolation(
        "SALARY_PERIOD_SETTLED",
        "Pay for that month is already approved",
        { field: "effectiveFrom" },
      );
    try {
      const salary = await tx.employeeSalary.create({
        data: {
          organizationId: ctx.organizationId,
          employeeId: e.id,
          effectiveFrom: asDate(input.effectiveFrom),
          basic: input.basic,
          payMethod: input.payMethod,
          note: input.note,
          createdByUserId: ctx.userId,
          items: {
            // organizationId comes from the salary (the relation shares it).
            create: input.items.map((i) => ({
              code: i.code,
              name: i.name,
              amount: i.amount,
              inContributionBase: i.inContributionBase,
            })),
          },
        },
        select: { id: true },
      });
      // Amounts are pay data: the audit says that pay changed, not to what.
      await recordAudit(tx, actorOf(ctx), {
        action: "employee_salary.set",
        entityType: "employee",
        entityId: e.id,
        changes: { effectiveFrom: input.effectiveFrom, items: input.items.length },
      });
      return salary;
    } catch (error) {
      if ((error as { code?: string }).code === "P2002")
        throw conflict("A salary already starts on that date", { field: "effectiveFrom" });
      throw error;
    }
  });
}

export async function employeePay(ctx: TenantContext, employeeId: string) {
  assertPermission(ctx.grants, "payroll.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployee(tx, ctx, employeeId);
    const [salaries, bank] = await inSequence([
      tx.employeeSalary.findMany({
        where: { organizationId: ctx.organizationId, employeeId: e.id },
        orderBy: { effectiveFrom: "desc" },
        include: { items: { orderBy: { code: "asc" } } },
      }),
      tx.employeeBankAccount.findUnique({
        where: {
          organizationId_employeeId: { organizationId: ctx.organizationId, employeeId: e.id },
        },
        select: { bankName: true, ibanLast4: true, updatedAt: true },
      }),
    ]);
    return {
      currency: e.branch.company.currency,
      salaries: salaries.map((s) => ({
        id: s.id,
        effectiveFrom: day(s.effectiveFrom),
        basic: dec(s.basic),
        payMethod: s.payMethod,
        note: s.note,
        items: s.items.map((i) => ({
          code: i.code,
          name: i.name,
          amount: dec(i.amount),
          inContributionBase: i.inContributionBase,
        })),
        total: s.items.reduce((a, i) => a.plus(dec(i.amount)), dec(s.basic)),
      })),
      bank,
      canManage: canManagePayroll(ctx),
    };
  });
}

export async function setBankAccount(ctx: TenantContext, employeeId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "payroll.manage");
  const parsed = z
    .object({
      bankName: requiredText(80),
      iban: z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .refine((v) => ibanProblem(v) === null, { error: "invalidIban" }),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { bankName, iban } = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployee(tx, ctx, employeeId);
    const data = {
      bankName,
      ibanSealed: encryptSecret(iban, sealKey()),
      ibanLast4: iban.slice(-4),
      updatedByUserId: ctx.userId,
    };
    await tx.employeeBankAccount.upsert({
      where: {
        organizationId_employeeId: { organizationId: ctx.organizationId, employeeId: e.id },
      },
      create: { organizationId: ctx.organizationId, employeeId: e.id, ...data },
      update: data,
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "employee_bank_account.set",
      entityType: "employee",
      entityId: e.id,
      changes: { bankName, ibanLast4: iban.slice(-4) },
    });
  });
}

// ─── Contribution rules ───

const ruleSchema = z
  .object({
    companyId: uuidSchema,
    code,
    name: requiredText(80),
    appliesTo: z.enum(APPLIES_TO),
    employeeRatePercent: fraction,
    employerRatePercent: fraction,
    baseMin: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined))
      .pipe(decimalString({ maxScale: 4, min: "0", max: "999999999" }).optional()),
    baseMax: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined))
      .pipe(decimalString({ maxScale: 4, min: "0", max: "999999999" }).optional()),
    effectiveFrom: date,
    source: requiredText(300),
  })
  .refine(
    (r) => new Decimal(r.employeeRatePercent).gt(0) || new Decimal(r.employerRatePercent).gt(0),
    {
      error: "atLeastOneValue",
      path: ["employeeRatePercent"],
    },
  )
  .refine((r) => !r.baseMin || !r.baseMax || new Decimal(r.baseMin).lte(r.baseMax), {
    error: "maxBelowMin",
    path: ["baseMax"],
  });

/** A contribution as the organization enters it, from a date (Q-20: nothing preset). */
export async function addContributionRule(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "payroll.manage");
  const parsed = ruleSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const r = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const company = await tx.company.findFirst({
      where: { organizationId: ctx.organizationId, id: r.companyId },
      select: { id: true, country: true },
    });
    if (!company) throw notFound("Company");
    if (r.appliesTo !== "ALL" && !company.country)
      throw businessRuleViolation(
        "COMPANY_COUNTRY_REQUIRED",
        "Set the company's country to tell nationals from others",
        { field: "appliesTo" },
      );
    // The same code continues: the earlier open rule ends the day before.
    const open = await tx.payrollContributionRule.findFirst({
      where: {
        organizationId: ctx.organizationId,
        companyId: company.id,
        code: r.code,
        effectiveTo: null,
      },
    });
    if (open && day(open.effectiveFrom) >= r.effectiveFrom)
      throw businessRuleViolation("RULE_DATE_BEFORE_CURRENT", "Start after the current rule", {
        field: "effectiveFrom",
      });
    if (open)
      await tx.payrollContributionRule.update({
        where: { id: open.id },
        data: { effectiveTo: new Date(asDate(r.effectiveFrom).getTime() - 86_400_000) },
      });
    const rule = await tx.payrollContributionRule.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: company.id,
        code: r.code,
        name: r.name,
        appliesTo: r.appliesTo,
        employeeRate: r.employeeRatePercent,
        employerRate: r.employerRatePercent,
        baseMin: r.baseMin ?? null,
        baseMax: r.baseMax ?? null,
        effectiveFrom: asDate(r.effectiveFrom),
        source: r.source,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "payroll_rule.added",
      entityType: "company",
      entityId: company.id,
      changes: {
        code: r.code,
        appliesTo: r.appliesTo,
        employeeRate: r.employeeRatePercent,
        employerRate: r.employerRatePercent,
        baseMin: r.baseMin ?? null,
        baseMax: r.baseMax ?? null,
        effectiveFrom: r.effectiveFrom,
        replaced: open?.id ?? null,
      },
    });
    return rule;
  });
}

export async function endContributionRule(ctx: TenantContext, ruleId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "payroll.manage");
  const parsed = z.object({ effectiveTo: date }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const rule = await tx.payrollContributionRule.findFirst({
      where: { organizationId: ctx.organizationId, id: ruleId },
    });
    if (!rule) throw notFound("Rule");
    if (rule.effectiveTo) throw businessRuleViolation("RULE_ENDED", "This rule has already ended");
    if (parsed.data.effectiveTo < day(rule.effectiveFrom))
      throw businessRuleViolation("RULE_END_BEFORE_START", "End on or after the start", {
        field: "effectiveTo",
      });
    await tx.payrollContributionRule.update({
      where: { id: rule.id },
      data: { effectiveTo: asDate(parsed.data.effectiveTo) },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "payroll_rule.ended",
      entityType: "company",
      entityId: rule.companyId,
      changes: { code: rule.code, effectiveTo: parsed.data.effectiveTo },
    });
  });
}

export async function listContributionRules(ctx: TenantContext) {
  assertPermission(ctx.grants, "payroll.view");
  return withTenantTx(ctx.organizationId, async (tx) => ({
    companies: await tx.company.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, code: true, name: true, country: true, currency: true },
      orderBy: { code: "asc" },
    }),
    rules: (
      await tx.payrollContributionRule.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: [{ companyId: "asc" }, { code: "asc" }, { effectiveFrom: "desc" }],
        include: { company: { select: { code: true, currency: true } } },
      })
    ).map((r) => ({
      ...r,
      employeeRate: dec(r.employeeRate),
      employerRate: dec(r.employerRate),
      baseMin: r.baseMin ? dec(r.baseMin) : null,
      baseMax: r.baseMax ? dec(r.baseMax) : null,
      effectiveFrom: day(r.effectiveFrom),
      effectiveTo: r.effectiveTo ? day(r.effectiveTo) : null,
    })),
    canManage: canManagePayroll(ctx),
  }));
}

// ─── Runs ───

async function loadRun(tx: Tx, ctx: TenantContext, runId: string) {
  const run = await tx.payrollRun.findFirst({
    where: { organizationId: ctx.organizationId, id: runId },
    include: { company: { select: { id: true, code: true, name: true, country: true } } },
  });
  if (!run) throw notFound("Payroll run");
  return run;
}

/** Work out every line of a draft run again from salaries, leave, rules and adjustments. */
async function computeRunInTx(tx: Tx, ctx: TenantContext, runId: string) {
  const run = await loadRun(tx, ctx, runId);
  const period = day(run.period).slice(0, 7);
  const p = periodBounds(period);
  const [employees, rules, leave, adjustments] = await inSequence([
    tx.employee.findMany({
      where: {
        organizationId: ctx.organizationId,
        branch: { companyId: run.companyId },
        hireDate: { lte: asDate(p.end) },
        OR: [{ terminatedOn: null }, { terminatedOn: { gte: asDate(p.start) } }],
      },
      select: {
        id: true,
        number: true,
        firstName: true,
        lastName: true,
        nationality: true,
        branchId: true,
        hireDate: true,
        terminatedOn: true,
        salaries: {
          where: { effectiveFrom: { lte: asDate(p.end) } },
          orderBy: { effectiveFrom: "desc" },
          take: 1,
          include: { items: true },
        },
      },
      orderBy: { number: "asc" },
    }),
    tx.payrollContributionRule.findMany({
      where: {
        organizationId: ctx.organizationId,
        companyId: run.companyId,
        effectiveFrom: { lte: asDate(p.end) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: asDate(p.end) } }],
      },
      orderBy: { code: "asc" },
    }),
    tx.leaveRequest.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: "APPROVED",
        leaveType: { paid: false },
        startDate: { lte: asDate(p.end) },
        endDate: { gte: asDate(p.start) },
        employee: { branch: { companyId: run.companyId } },
      },
      select: { employeeId: true, startDate: true, endDate: true, days: true },
    }),
    tx.payrollAdjustment.findMany({
      where: { organizationId: ctx.organizationId, runId: run.id },
    }),
  ]);
  await tx.payrollLine.deleteMany({ where: { organizationId: ctx.organizationId, runId: run.id } });
  const skipped: Array<{ employeeId: string; number: string; reason: string }> = [];
  const totals = {
    gross: new Decimal(0),
    deductions: new Decimal(0),
    net: new Decimal(0),
    employerContributions: new Decimal(0),
    employerCost: new Decimal(0),
  };
  for (const e of employees) {
    const salary = e.salaries[0];
    if (!salary) {
      skipped.push({ employeeId: e.id, number: e.number, reason: "NO_SALARY" });
      continue;
    }
    const days = paidDays({
      basis: run.prorationBasis,
      period,
      hireDate: day(e.hireDate),
      terminatedOn: e.terminatedOn ? day(e.terminatedOn) : null,
    });
    if (days.paidDays === 0) continue;
    const line = computeLine({
      currency: run.currency,
      basisDays: days.basisDays,
      paidDays: days.paidDays,
      unpaidLeaveDays: unpaidDaysIn(
        period,
        leave
          .filter((l) => l.employeeId === e.id)
          .map((l) => ({
            startDate: day(l.startDate),
            endDate: day(l.endDate),
            days: dec(l.days),
          })),
      ),
      salary: {
        basic: dec(salary.basic),
        items: salary.items.map((i) => ({
          code: i.code,
          name: i.name,
          amount: dec(i.amount),
          inContributionBase: i.inContributionBase,
        })),
      },
      rules: rules
        .filter((r) => ruleApplies(r.appliesTo, e.nationality, run.company.country))
        .map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          employeeRate: dec(r.employeeRate),
          employerRate: dec(r.employerRate),
          baseMin: r.baseMin ? dec(r.baseMin) : null,
          baseMax: r.baseMax ? dec(r.baseMax) : null,
        })),
      adjustments: adjustments
        .filter((a) => a.employeeId === e.id)
        .map((a) => ({ kind: a.kind, category: a.category, amount: dec(a.amount) })),
    });
    await tx.payrollLine.create({
      data: {
        organizationId: ctx.organizationId,
        runId: run.id,
        employeeId: e.id,
        salaryId: salary.id,
        branchId: e.branchId,
        payMethod: salary.payMethod,
        basisDays: line.basisDays,
        paidDays: line.paidDays,
        unpaidLeaveDays: line.unpaidLeaveDays.toDecimalPlaces(2).toFixed(),
        fixedPay: line.fixedPay.toFixed(),
        additions: line.additions.toFixed(),
        gross: line.gross.toFixed(),
        unpaidLeaveDeduction: line.unpaidLeaveDeduction.toFixed(),
        employeeContributions: line.employeeContributions.toFixed(),
        otherDeductions: line.otherDeductions.toFixed(),
        net: line.net.toFixed(),
        employerContributions: line.employerContributions.toFixed(),
        employerCost: line.employerCost.toFixed(),
        details: JSON.parse(
          JSON.stringify({ components: line.components, contributions: line.contributions }),
        ),
      },
    });
    totals.gross = totals.gross.plus(line.gross);
    totals.deductions = totals.deductions.plus(line.totalDeductions);
    totals.net = totals.net.plus(line.net);
    totals.employerContributions = totals.employerContributions.plus(line.employerContributions);
    totals.employerCost = totals.employerCost.plus(line.employerCost);
  }
  await tx.payrollRun.update({
    where: { id: run.id },
    data: {
      gross: totals.gross.toFixed(),
      deductions: totals.deductions.toFixed(),
      net: totals.net.toFixed(),
      employerContributions: totals.employerContributions.toFixed(),
      employerCost: totals.employerCost.toFixed(),
      skipped,
    },
  });
}

export async function createPayrollRun(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "payroll.manage");
  const parsed = z
    .object({
      companyId: uuidSchema,
      period: z
        .string()
        .refine((v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v), { error: "invalidPeriod" }),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { companyId, period } = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const settings = await tx.payrollSettings.findUnique({
      where: { organizationId: ctx.organizationId },
    });
    if (!settings)
      throw businessRuleViolation(
        "PRORATION_BASIS_REQUIRED",
        "Choose how part months are paid before the first run",
      );
    const company = await tx.company.findFirst({
      where: { organizationId: ctx.organizationId, id: companyId, archivedAt: null },
      select: { id: true, currency: true },
    });
    if (!company) throw notFound("Company");
    const live = await tx.payrollRun.findFirst({
      where: {
        organizationId: ctx.organizationId,
        companyId: company.id,
        period: asDate(`${period}-01`),
        status: { not: "CANCELLED" },
      },
      select: { number: true },
    });
    if (live) throw conflict(`This month already has run ${live.number}`, { field: "period" });
    const run = await tx.payrollRun.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: company.id,
        number: await nextDocumentNumber(tx, ctx.organizationId, "PAY", Number(period.slice(0, 4))),
        period: asDate(`${period}-01`),
        currency: company.currency,
        prorationBasis: settings.prorationBasis as ProrationBasis,
        preparedByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    await computeRunInTx(tx, ctx, run.id);
    await recordAudit(tx, actorOf(ctx), {
      action: "payroll_run.created",
      entityType: "payroll_run",
      entityId: run.id,
      changes: { number: run.number, period },
    });
    return run;
  });
}

async function draftRun(tx: Tx, ctx: TenantContext, runId: string) {
  const run = await loadRun(tx, ctx, runId);
  if (run.status !== "DRAFT")
    throw businessRuleViolation("PAYROLL_RUN_NOT_DRAFT", "Only a draft run can change");
  return run;
}

export async function recalculatePayrollRun(ctx: TenantContext, runId: string) {
  assertPermission(ctx.grants, "payroll.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    await draftRun(tx, ctx, runId);
    await computeRunInTx(tx, ctx, runId);
  });
}

const adjustmentSchema = z
  .object({
    employeeId: uuidSchema,
    kind: z.enum(["ADDITION", "DEDUCTION"]),
    category: z.string(),
    amount: money({ min: "0.0001" }),
    note: optionalText(200),
  })
  .refine((a) => (ADJUSTMENT_CATEGORIES[a.kind] as readonly string[]).includes(a.category), {
    error: "invalidOption",
    path: ["category"],
  });

export async function addPayrollAdjustment(ctx: TenantContext, runId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "payroll.manage");
  const parsed = adjustmentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const a = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const run = await draftRun(tx, ctx, runId);
    const onRun = await tx.payrollLine.findFirst({
      where: { organizationId: ctx.organizationId, runId: run.id, employeeId: a.employeeId },
      select: { id: true },
    });
    if (!onRun)
      throw businessRuleViolation("EMPLOYEE_NOT_ON_RUN", "This employee is not paid in this run", {
        field: "employeeId",
      });
    await tx.payrollAdjustment.create({
      data: {
        organizationId: ctx.organizationId,
        runId: run.id,
        employeeId: a.employeeId,
        kind: a.kind,
        category: a.category,
        amount: a.amount,
        note: a.note,
        createdByUserId: ctx.userId,
      },
    });
    await computeRunInTx(tx, ctx, run.id);
  });
}

export async function removePayrollAdjustment(ctx: TenantContext, adjustmentId: string) {
  assertPermission(ctx.grants, "payroll.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const a = await tx.payrollAdjustment.findFirst({
      where: { organizationId: ctx.organizationId, id: adjustmentId },
    });
    if (!a) throw notFound("Adjustment");
    await draftRun(tx, ctx, a.runId);
    await tx.payrollAdjustment.delete({ where: { id: a.id } });
    await computeRunInTx(tx, ctx, a.runId);
  });
}

/** Approve: someone other than the preparer, with no negative net pay. */
export async function approvePayrollRun(ctx: TenantContext, runId: string) {
  assertPermission(ctx.grants, "payroll.approve");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const run = await draftRun(tx, ctx, runId);
    if (run.preparedByUserId === ctx.userId)
      throw businessRuleViolation(
        "PAYROLL_SELF_APPROVAL",
        "Someone other than the preparer approves the run",
      );
    const lines = await tx.payrollLine.findMany({
      where: { organizationId: ctx.organizationId, runId: run.id },
      select: { net: true, employee: { select: { number: true } } },
    });
    if (lines.length === 0)
      throw businessRuleViolation("PAYROLL_RUN_EMPTY", "Nobody is paid in this run");
    const negative = lines.filter((l) => dec(l.net).lt(0)).map((l) => l.employee.number);
    if (negative.length)
      throw businessRuleViolation("PAYROLL_NEGATIVE_NET", "Net pay is below zero", {
        employees: negative,
      });
    await tx.payrollRun.update({
      where: { id: run.id },
      data: { status: "APPROVED", approvedByUserId: ctx.userId, approvedAt: new Date() },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "payroll_run.approved",
      entityType: "payroll_run",
      entityId: run.id,
      changes: { lines: lines.length, net: dec(run.net).toFixed() },
    });
  });
}

export async function markPayrollRunPaid(ctx: TenantContext, runId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "payroll.manage");
  const parsed = z.object({ paidOn: date }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const run = await loadRun(tx, ctx, runId);
    if (run.status !== "APPROVED")
      throw businessRuleViolation("PAYROLL_RUN_NOT_APPROVED", "Approve the run first");
    await tx.payrollRun.update({
      where: { id: run.id },
      data: { status: "PAID", paidOn: asDate(parsed.data.paidOn) },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "payroll_run.paid",
      entityType: "payroll_run",
      entityId: run.id,
      changes: { paidOn: parsed.data.paidOn },
    });
  });
}

export async function cancelPayrollRun(ctx: TenantContext, runId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "payroll.manage");
  const parsed = z.object({ reason: requiredText(200) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const run = await loadRun(tx, ctx, runId);
    if (run.status === "PAID" || run.status === "CANCELLED")
      throw businessRuleViolation(
        "PAYROLL_RUN_CLOSED",
        "A paid or cancelled run cannot be cancelled",
      );
    await tx.payrollRun.update({
      where: { id: run.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: parsed.data.reason },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "payroll_run.cancelled",
      entityType: "payroll_run",
      entityId: run.id,
      changes: { reason: parsed.data.reason },
    });
  });
}

export async function listPayrollRuns(ctx: TenantContext) {
  assertPermission(ctx.grants, "payroll.view");
  return withTenantTx(ctx.organizationId, async (tx) => ({
    runs: await tx.payrollRun.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ period: "desc" }, { createdAt: "desc" }],
      take: 60,
      select: {
        id: true,
        number: true,
        period: true,
        status: true,
        currency: true,
        net: true,
        employerCost: true,
        company: { select: { code: true, name: true } },
        _count: { select: { lines: true } },
      },
    }),
    companies: await tx.company.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prorationBasis:
      (await tx.payrollSettings.findUnique({ where: { organizationId: ctx.organizationId } }))
        ?.prorationBasis ?? null,
    canManage: canManagePayroll(ctx),
  }));
}

export interface LineDetails {
  components: Array<{ code: string; name: string; amount: string }>;
  contributions: Array<{
    ruleId: string;
    code: string;
    name: string;
    base: string;
    employee: string;
    employer: string;
  }>;
}

export async function getPayrollRun(ctx: TenantContext, runId: string) {
  assertPermission(ctx.grants, "payroll.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const run = await loadRun(tx, ctx, runId);
    const [lines, adjustments] = await inSequence([
      tx.payrollLine.findMany({
        where: { organizationId: ctx.organizationId, runId: run.id },
        include: {
          employee: {
            select: {
              id: true,
              number: true,
              firstName: true,
              lastName: true,
              jobTitle: true,
              bankAccount: { select: { ibanLast4: true } },
            },
          },
        },
        orderBy: { employee: { number: "asc" } },
      }),
      tx.payrollAdjustment.findMany({
        where: { organizationId: ctx.organizationId, runId: run.id },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return {
      run: { ...run, period: day(run.period).slice(0, 7) },
      lines: lines.map((l) => ({ ...l, details: l.details as unknown as LineDetails })),
      adjustments,
      skipped: run.skipped as Array<{ employeeId: string; number: string; reason: string }>,
      canManage: canManagePayroll(ctx),
      canApprove:
        hasPermission(ctx.grants, "payroll.approve") && run.preparedByUserId !== ctx.userId,
    };
  });
}

/** Bank transfer list for an approved run: employee, bank, IBAN, net. Audited by count. */
export async function exportBankFileCsv(ctx: TenantContext, runId: string) {
  assertPermission(ctx.grants, "payroll.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const run = await loadRun(tx, ctx, runId);
    if (run.status !== "APPROVED" && run.status !== "PAID")
      throw businessRuleViolation("PAYROLL_RUN_NOT_APPROVED", "Approve the run first");
    const lines = await tx.payrollLine.findMany({
      where: { organizationId: ctx.organizationId, runId: run.id, payMethod: "BANK" },
      include: {
        employee: {
          select: { number: true, firstName: true, lastName: true, bankAccount: true },
        },
      },
      orderBy: { employee: { number: "asc" } },
    });
    const missing = lines.filter((l) => !l.employee.bankAccount).map((l) => l.employee.number);
    if (missing.length)
      throw businessRuleViolation("BANK_ACCOUNT_MISSING", "Some employees have no bank account", {
        employees: missing,
      });
    await recordAudit(tx, actorOf(ctx), {
      action: "payroll_run.bank_file_exported",
      entityType: "payroll_run",
      entityId: run.id,
      changes: { lines: lines.length },
    });
    return toCsv(
      ["employee_number", "name", "bank", "iban", "amount", "currency", "reference"],
      lines.map((l) => [
        l.employee.number,
        `${l.employee.firstName} ${l.employee.lastName}`,
        l.employee.bankAccount!.bankName,
        decryptSecret(l.employee.bankAccount!.ibanSealed, sealKey()),
        dec(l.net).toFixed(),
        run.currency,
        `${run.number} ${day(run.period).slice(0, 7)}`,
      ]),
    );
  });
}

// ─── Payslips ───

/** A payslip: payroll viewers see any; an employee sees their own once approved. */
export async function getPayslip(ctx: TenantContext, lineId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const line = await tx.payrollLine.findFirst({
      where: { organizationId: ctx.organizationId, id: lineId },
      include: {
        run: { include: { company: { select: { id: true } } } },
        employee: {
          select: {
            number: true,
            firstName: true,
            lastName: true,
            nameAr: true,
            jobTitle: true,
            userId: true,
            bankAccount: { select: { bankName: true, ibanLast4: true } },
          },
        },
      },
    });
    if (!line) throw notFound("Payslip");
    const own = line.employee.userId === ctx.userId && ctx.userId !== null;
    if (!canViewPayroll(ctx)) {
      if (!own || (line.run.status !== "APPROVED" && line.run.status !== "PAID"))
        throw notFound("Payslip");
    }
    const adjustments = await tx.payrollAdjustment.findMany({
      where: { organizationId: ctx.organizationId, runId: line.runId, employeeId: line.employeeId },
      orderBy: { createdAt: "asc" },
    });
    return {
      line: { ...line, details: line.details as unknown as LineDetails },
      adjustments,
      period: day(line.run.period).slice(0, 7),
      final: line.run.status === "APPROVED" || line.run.status === "PAID",
    };
  });
}

/** The signed-in person's own payslips (approved or paid runs). */
export async function myPayslips(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const me = await tx.employee.findFirst({
      where: { organizationId: ctx.organizationId, userId: ctx.userId },
      select: { id: true },
    });
    if (!me) throw forbidden();
    return tx.payrollLine.findMany({
      where: {
        organizationId: ctx.organizationId,
        employeeId: me.id,
        run: { status: { in: ["APPROVED", "PAID"] } },
      },
      orderBy: { run: { period: "desc" } },
      select: {
        id: true,
        net: true,
        gross: true,
        run: { select: { number: true, period: true, currency: true, status: true, paidOn: true } },
      },
    });
  });
}
