import "server-only";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { businessDate } from "@/modules/inventory/rules";
import { USAGE_METRICS, type UsageMetric } from "@/modules/usage/rules";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { withSystemTx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import { logger } from "@/server/logger";
import { computeStatement, isListedEmail, planSchema, type MetricPricing } from "./rules";

/**
 * The platform operator's side of billing (DECISIONS.md ADR-147): plans and
 * prices, which plan each organization is on, and monthly statements from
 * metered usage (ADR-146). An operator is a signed-in person whose email is
 * in PLATFORM_ADMIN_EMAILS and who has two-factor sign-in on. Statements are
 * drafts until issued; an issued statement is fixed (database trigger).
 */

export interface PlatformOperator {
  id: string;
  email: string;
}

/** The signed-in operator, or why not (null: not signed in). */
export async function platformOperator(): Promise<
  | { ok: true; operator: PlatformOperator }
  | { ok: false; reason: "NOT_LISTED" | "NO_TWO_FACTOR" }
  | null
> {
  const user = await getCurrentUser();
  if (!user) return null;
  if (!isListedEmail(getEnv().PLATFORM_ADMIN_EMAILS, user.email))
    return { ok: false, reason: "NOT_LISTED" };
  const row = await getDb().user.findUnique({
    where: { id: user.id },
    select: { twoFactorEnabled: true },
  });
  if (!row?.twoFactorEnabled) return { ok: false, reason: "NO_TWO_FACTOR" };
  return { ok: true, operator: { id: user.id, email: user.email } };
}

/** For pages and actions: the operator, or forbidden. Every function below takes its result. */
export async function requireOperator(): Promise<PlatformOperator> {
  const r = await platformOperator();
  if (!r?.ok) throw forbidden();
  return r.operator;
}

const log = (op: PlatformOperator, action: string, fields: Record<string, unknown>) =>
  logger.info(`platform.${action}`, { operator: op.id, ...fields });

// ─── Plans ───

export async function listPlans(op: PlatformOperator) {
  if (!op) throw forbidden();
  return withSystemTx((tx) =>
    tx.billingPlan.findMany({
      orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { code: "asc" }],
      include: { _count: { select: { organizations: true } } },
    }),
  );
}

/** Create or update a plan by code. Changing a plan changes only statements not yet issued. */
export async function savePlan(op: PlatformOperator, raw: unknown) {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const p = parsed.data;
  const plan = await withSystemTx((tx) =>
    tx.billingPlan.upsert({
      where: { code: p.code },
      create: {
        code: p.code,
        name: p.name,
        currency: p.currency,
        monthlyFee: p.monthlyFee,
        pricing: p.pricing,
      },
      update: {
        name: p.name,
        currency: p.currency,
        monthlyFee: p.monthlyFee,
        pricing: p.pricing,
        archivedAt: null,
      },
    }),
  );
  log(op, "plan_saved", { code: p.code });
  return plan;
}

export async function archivePlan(op: PlatformOperator, planId: string) {
  await withSystemTx(async (tx) => {
    const plan = await tx.billingPlan.findUnique({
      where: { id: planId },
      include: { _count: { select: { organizations: true } } },
    });
    if (!plan) throw notFound("Plan");
    if (plan._count.organizations > 0)
      throw businessRuleViolation("PLAN_IN_USE", "Move its organizations to another plan first");
    await tx.billingPlan.update({ where: { id: planId }, data: { archivedAt: new Date() } });
  });
  log(op, "plan_archived", { planId });
}

// ─── Organizations ───

export async function listBillingOrganizations(op: PlatformOperator) {
  if (!op) throw forbidden();
  return withSystemTx((tx) =>
    tx.organization.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        slug: true,
        billingPlanSince: true,
        billingPlan: { select: { id: true, code: true, name: true } },
      },
      orderBy: { name: "asc" },
    }),
  );
}

/** Put an organization on a plan (or none) from today. */
export async function assignPlan(
  op: PlatformOperator,
  organizationId: string,
  planId: string | null,
) {
  await withSystemTx(async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, timeZone: true },
    });
    if (!org) throw notFound("Organization");
    if (planId) {
      const plan = await tx.billingPlan.findUnique({ where: { id: planId } });
      if (!plan || plan.archivedAt) throw notFound("Plan");
    }
    await tx.organization.update({
      where: { id: org.id },
      data: planId
        ? {
            billingPlanId: planId,
            billingPlanSince: new Date(`${businessDate(org.timeZone)}T00:00:00Z`),
          }
        : { billingPlanId: null, billingPlanSince: null },
    });
  });
  log(op, "plan_assigned", { organizationId, planId });
}

// ─── Statements ───

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

async function usedInMonth(organizationId: string, month: string) {
  const [y, m] = month.split("-").map(Number);
  const to = new Date(Date.UTC(y, m, 0));
  const rows = await withSystemTx((tx) =>
    tx.usageDaily.groupBy({
      by: ["metric"],
      where: {
        organizationId,
        day: { gte: new Date(`${month}-01T00:00:00Z`), lte: to },
      },
      _sum: { quantity: true },
    }),
  );
  return Object.fromEntries(
    rows
      .filter((r) => (USAGE_METRICS as readonly string[]).includes(r.metric))
      .map((r) => [r.metric, Number(r._sum.quantity ?? 0)]),
  ) as Partial<Record<UsageMetric, number>>;
}

/**
 * (Re)make the month's draft statement for every organization on a plan.
 * Issued statements are left as they are.
 */
export async function generateStatements(op: PlatformOperator, rawMonth: string) {
  return generateStatementsFor(rawMonth, op);
}

export async function generateStatementsFor(rawMonth: string, op: PlatformOperator | null) {
  const month = monthSchema.safeParse(rawMonth);
  if (!month.success) throw businessRuleViolation("INVALID_MONTH", "Choose a month (YYYY-MM)");
  const orgs = await withSystemTx((tx) =>
    tx.organization.findMany({
      where: { status: "ACTIVE", billingPlanId: { not: null } },
      select: { id: true, billingPlan: true },
    }),
  );
  let made = 0;
  for (const o of orgs) {
    const plan = o.billingPlan!;
    const pricing = (plan.pricing ?? {}) as Partial<Record<UsageMetric, MetricPricing>>;
    const statement = computeStatement(
      { monthlyFee: new Decimal(plan.monthlyFee.toString()).toFixed(4), pricing },
      await usedInMonth(o.id, month.data),
    );
    const snapshot = {
      code: plan.code,
      name: plan.name,
      currency: plan.currency,
      monthlyFee: new Decimal(plan.monthlyFee.toString()).toFixed(2),
      pricing,
    };
    const done = await withSystemTx(async (tx) => {
      const existing = await tx.billingStatement.findUnique({
        where: { organizationId_month: { organizationId: o.id, month: month.data } },
      });
      if (existing?.status === "ISSUED") return false;
      const data = {
        currency: plan.currency,
        plan: snapshot,
        lines: statement.lines as unknown as object[],
        total: statement.total,
        generatedAt: new Date(),
      };
      if (existing) await tx.billingStatement.update({ where: { id: existing.id }, data });
      else
        await tx.billingStatement.create({
          data: { organizationId: o.id, month: month.data, ...data },
        });
      return true;
    });
    if (done) made += 1;
  }
  if (op) log(op, "statements_generated", { month: month.data, made });
  return { month: month.data, made };
}

export async function listStatements(op: PlatformOperator, rawMonth: string) {
  if (!op) throw forbidden();
  const month = monthSchema.safeParse(rawMonth);
  if (!month.success) return [];
  return withSystemTx((tx) =>
    tx.billingStatement.findMany({
      where: { month: month.data },
      include: { organization: { select: { name: true, slug: true } } },
      orderBy: { organization: { name: "asc" } },
    }),
  );
}

/** Issue a statement: from then on it is fixed. */
export async function issueStatement(op: PlatformOperator, statementId: string) {
  await withSystemTx(async (tx) => {
    const s = await tx.billingStatement.findUnique({ where: { id: statementId } });
    if (!s) throw notFound("Statement");
    if (s.status === "ISSUED") throw businessRuleViolation("STATEMENT_ISSUED", "Already issued");
    await tx.billingStatement.update({
      where: { id: s.id },
      data: { status: "ISSUED", issuedAt: new Date(), issuedBy: op.email },
    });
  });
  log(op, "statement_issued", { statementId });
}
