import "server-only";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { optionalText, requiredText } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import {
  allowedSteps,
  distribution,
  GOAL_STATUSES,
  goalScore,
  weightsWithin,
  type ReviewStatus,
  type ReviewStep,
} from "./rules";

/**
 * Goals and performance reviews (DECISIONS.md ADR-126). HR (`performance.
 * manage`, per branch) runs cycles; each employee reviews themself, their
 * manager (the reporting line, HR1) rates each goal and gives an overall
 * rating, the employee acknowledges, and HR finalizes — changing the
 * rating only with a reason. Ratings are 1–5.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const date = z.string().refine(isCalendarDate, { error: "invalidDate" });
const optionalDate = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .refine((v) => v === undefined || isCalendarDate(v), { error: "invalidDate" });
const rating = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => /^[1-5]$/.test(v), { error: "invalidRating" })
  .transform(Number);
const optionalRating = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .refine((v) => v === undefined || /^[1-5]$/.test(v), { error: "invalidRating" })
  .transform((v) => (v === undefined ? null : Number(v)));
const percent = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => /^\d{1,3}$/.test(v) && Number(v) <= 100, { error: "invalidPercent" })
  .transform(Number);

export const canViewPerformance = (ctx: TenantContext) =>
  holdsAnyGrant(ctx.grants, "performance.view") || holdsAnyGrant(ctx.grants, "performance.manage");
const manageAt = (ctx: TenantContext, branchId: string | null) =>
  branchId
    ? hasPermission(ctx.grants, "performance.manage", { branchId })
    : hasPermission(ctx.grants, "performance.manage");
const viewAt = (ctx: TenantContext, branchId: string) =>
  hasPermission(ctx.grants, "performance.view", { branchId }) || manageAt(ctx, branchId);
function viewBranches(ctx: TenantContext): string[] | null {
  const v = accessibleScope(ctx.grants, "performance.view");
  const m = accessibleScope(ctx.grants, "performance.manage");
  if (v.all || m.all) return null;
  return [...new Set([...v.branchIds, ...m.branchIds])];
}

async function me(tx: Tx, ctx: TenantContext) {
  return tx.employee.findFirst({
    where: { organizationId: ctx.organizationId, userId: ctx.userId },
    select: { id: true },
  });
}

// ─── Cycles ───

const cycleSchema = z
  .object({
    name: requiredText(120),
    branchId: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined))
      .pipe(z.uuid().optional()),
    periodStart: date,
    periodEnd: date,
    selfDueOn: date,
    managerDueOn: date,
  })
  .refine((c) => c.periodEnd >= c.periodStart, { error: "invalidPeriod", path: ["periodEnd"] })
  .refine((c) => c.managerDueOn >= c.selfDueOn, { error: "invalidPeriod", path: ["managerDueOn"] });

export async function createCycle(ctx: TenantContext, rawInput: unknown) {
  const parsed = cycleSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const c = parsed.data;
  if (!manageAt(ctx, c.branchId ?? null)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    if (c.branchId) {
      const b = await tx.branch.findFirst({
        where: { organizationId: ctx.organizationId, id: c.branchId, archivedAt: null },
      });
      if (!b) throw notFound("Branch");
    }
    const cycle = await tx.performanceCycle.create({
      data: {
        organizationId: ctx.organizationId,
        name: c.name,
        branchId: c.branchId ?? null,
        periodStart: asDate(c.periodStart),
        periodEnd: asDate(c.periodEnd),
        selfDueOn: asDate(c.selfDueOn),
        managerDueOn: asDate(c.managerDueOn),
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "performance_cycle.created",
      entityType: "performance_cycle",
      entityId: cycle.id,
      changes: { name: c.name, from: c.periodStart, to: c.periodEnd },
    });
    return cycle;
  });
}

async function loadCycle(tx: Tx, ctx: TenantContext, cycleId: string) {
  const c = await tx.performanceCycle.findFirst({
    where: { organizationId: ctx.organizationId, id: cycleId },
  });
  if (!c) throw notFound("Cycle");
  const visible = c.branchId ? viewAt(ctx, c.branchId) : canViewPerformance(ctx);
  if (!visible) throw notFound("Cycle");
  return c;
}

/** Open the cycle: a review for each active employee in its scope, with their manager as reviewer. */
export async function launchCycle(ctx: TenantContext, cycleId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCycle(tx, ctx, cycleId);
    if (!manageAt(ctx, c.branchId)) throw forbidden();
    if (c.status !== "DRAFT")
      throw businessRuleViolation("CYCLE_NOT_DRAFT", "The cycle is already launched");
    const branches = c.branchId ? [c.branchId] : viewBranches(ctx);
    const staff = await tx.employee.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { not: "TERMINATED" },
        hireDate: { lte: c.periodEnd },
        ...(branches ? { branchId: { in: branches } } : {}),
      },
      select: { id: true, managerId: true },
    });
    if (staff.length === 0)
      throw businessRuleViolation("CYCLE_NO_STAFF", "Nobody is in this cycle's scope");
    await tx.performanceReview.createMany({
      data: staff.map((e) => ({
        organizationId: ctx.organizationId,
        cycleId: c.id,
        employeeId: e.id,
        reviewerEmployeeId: e.managerId,
      })),
    });
    await tx.performanceCycle.update({
      where: { id: c.id },
      data: { status: "OPEN", launchedAt: new Date() },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "performance_cycle.launched",
      entityType: "performance_cycle",
      entityId: c.id,
      changes: { reviews: staff.length },
    });
    return { reviews: staff.length };
  });
}

export async function closeCycle(ctx: TenantContext, cycleId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCycle(tx, ctx, cycleId);
    if (!manageAt(ctx, c.branchId)) throw forbidden();
    if (c.status !== "OPEN") throw businessRuleViolation("CYCLE_NOT_OPEN", "The cycle is not open");
    const open = await tx.performanceReview.count({
      where: {
        organizationId: ctx.organizationId,
        cycleId: c.id,
        status: { notIn: ["FINALIZED", "SKIPPED"] },
      },
    });
    if (open > 0)
      throw businessRuleViolation("CYCLE_REVIEWS_OPEN", "Finalize or skip every review first", {
        count: open,
      });
    await tx.performanceCycle.update({
      where: { id: c.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "performance_cycle.closed",
      entityType: "performance_cycle",
      entityId: c.id,
    });
  });
}

export async function listCycles(ctx: TenantContext) {
  if (!canViewPerformance(ctx)) throw forbidden();
  const branches = viewBranches(ctx);
  return withTenantTx(ctx.organizationId, async (tx) => ({
    cycles: await tx.performanceCycle.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(branches ? { branchId: { in: branches } } : {}),
      },
      include: { _count: { select: { reviews: true } } },
      orderBy: { periodStart: "desc" },
    }),
    branches: await tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(branches ? { id: { in: branches } } : {}),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    canManage: holdsAnyGrant(ctx.grants, "performance.manage"),
    canManageAll: hasPermission(ctx.grants, "performance.manage"),
  }));
}

export async function getCycle(ctx: TenantContext, cycleId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCycle(tx, ctx, cycleId);
    const branches = viewBranches(ctx);
    const reviews = await tx.performanceReview.findMany({
      where: {
        organizationId: ctx.organizationId,
        cycleId: c.id,
        ...(branches ? { employee: { branchId: { in: branches } } } : {}),
      },
      include: {
        employee: {
          select: {
            id: true,
            number: true,
            firstName: true,
            lastName: true,
            jobTitle: true,
            branch: { select: { code: true } },
          },
        },
        reviewer: { select: { firstName: true, lastName: true } },
      },
      orderBy: { employee: { number: "asc" } },
    });
    const byStatus = {} as Record<ReviewStatus, number>;
    for (const r of reviews) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    return {
      cycle: {
        ...c,
        periodStart: day(c.periodStart),
        periodEnd: day(c.periodEnd),
        selfDueOn: day(c.selfDueOn),
        managerDueOn: day(c.managerDueOn),
      },
      reviews,
      byStatus,
      distribution: distribution(reviews.filter((r) => r.status !== "SKIPPED")),
      canManage: manageAt(ctx, c.branchId),
    };
  });
}

// ─── Goals ───

async function loadEmployee(tx: Tx, ctx: TenantContext, employeeId: string) {
  const e = await tx.employee.findFirst({
    where: { organizationId: ctx.organizationId, id: employeeId },
    select: { id: true, branchId: true, managerId: true, userId: true },
  });
  if (!e) throw notFound("Employee");
  return e;
}

/** HR at the branch, or the employee's own manager, sets their goals. */
async function maySetGoals(
  tx: Tx,
  ctx: TenantContext,
  e: { branchId: string; managerId: string | null },
) {
  if (manageAt(ctx, e.branchId)) return true;
  const self = await me(tx, ctx);
  return !!self && self.id === e.managerId;
}

const goalSchema = z.object({
  cycleId: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .pipe(z.uuid().optional()),
  title: requiredText(200),
  description: optionalText(1000),
  weight: percent,
  dueOn: optionalDate,
});

export async function addGoal(ctx: TenantContext, employeeId: string, rawInput: unknown) {
  const parsed = goalSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const g = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployee(tx, ctx, employeeId);
    if (!(await maySetGoals(tx, ctx, e))) throw forbidden();
    if (g.cycleId) {
      const c = await tx.performanceCycle.findFirst({
        where: { organizationId: ctx.organizationId, id: g.cycleId },
      });
      if (!c || (c.branchId && c.branchId !== e.branchId)) throw notFound("Cycle");
      if (c.status === "CLOSED")
        throw businessRuleViolation("CYCLE_CLOSED", "The cycle is closed", { field: "cycleId" });
      const review = await tx.performanceReview.findFirst({
        where: { organizationId: ctx.organizationId, cycleId: c.id, employeeId: e.id },
        select: { status: true },
      });
      if (review && review.status !== "NOT_STARTED" && review.status !== "SELF_DONE")
        throw businessRuleViolation("REVIEW_ALREADY_RATED", "The review is already rated", {
          field: "cycleId",
        });
      const goals = await tx.performanceGoal.findMany({
        where: { organizationId: ctx.organizationId, employeeId: e.id, cycleId: c.id },
        select: { weight: true, status: true },
      });
      if (!weightsWithin(goals, g.weight))
        throw businessRuleViolation(
          "GOAL_WEIGHTS_OVER_100",
          "Goal weights in a cycle add up to at most 100",
          {
            field: "weight",
          },
        );
    }
    const goal = await tx.performanceGoal.create({
      data: {
        organizationId: ctx.organizationId,
        employeeId: e.id,
        cycleId: g.cycleId ?? null,
        title: g.title,
        description: g.description,
        weight: g.weight,
        dueOn: g.dueOn ? asDate(g.dueOn) : null,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "performance_goal.added",
      entityType: "employee",
      entityId: e.id,
      changes: { title: g.title, weight: g.weight, cycleId: g.cycleId ?? null },
    });
    return goal;
  });
}

/** Progress by the employee, their manager or HR; the outcome by the manager or HR. */
export async function updateGoal(ctx: TenantContext, goalId: string, rawInput: unknown) {
  const parsed = z
    .object({
      progress: percent,
      status: z
        .string()
        .optional()
        .transform((v) => (v && v.trim() ? v.trim() : undefined))
        .pipe(z.enum(GOAL_STATUSES).optional()),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const g = await tx.performanceGoal.findFirst({
      where: { organizationId: ctx.organizationId, id: goalId },
      include: { employee: { select: { branchId: true, managerId: true, userId: true } } },
    });
    if (!g) throw notFound("Goal");
    const own = g.employee.userId === ctx.userId;
    const lead = await maySetGoals(tx, ctx, g.employee);
    if (!own && !lead) throw notFound("Goal");
    const status = parsed.data.status;
    if (status && status !== g.status && !lead) throw forbidden();
    await tx.performanceGoal.update({
      where: { id: g.id },
      data: { progress: parsed.data.progress, ...(status && lead ? { status } : {}) },
    });
  });
}

export async function employeeGoals(ctx: TenantContext, employeeId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const e = await loadEmployee(tx, ctx, employeeId);
    const own = e.userId === ctx.userId;
    const lead = await maySetGoals(tx, ctx, e);
    if (!own && !lead && !viewAt(ctx, e.branchId)) throw notFound("Employee");
    const [goals, cycles, reviews] = await inSequence([
      tx.performanceGoal.findMany({
        where: { organizationId: ctx.organizationId, employeeId: e.id },
        include: { cycle: { select: { id: true, name: true, status: true } } },
        orderBy: [{ createdAt: "desc" }],
      }),
      tx.performanceCycle.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: { not: "CLOSED" },
          OR: [{ branchId: null }, { branchId: e.branchId }],
        },
        select: { id: true, name: true },
        orderBy: { periodStart: "desc" },
      }),
      tx.performanceReview.findMany({
        where: { organizationId: ctx.organizationId, employeeId: e.id },
        include: { cycle: { select: { name: true } } },
        orderBy: { cycle: { periodStart: "desc" } },
      }),
    ]);
    return { goals, cycles, reviews, canSetGoals: lead, own };
  });
}

// ─── Reviews ───

async function loadReview(tx: Tx, ctx: TenantContext, reviewId: string) {
  const r = await tx.performanceReview.findFirst({
    where: { organizationId: ctx.organizationId, id: reviewId },
    include: {
      cycle: true,
      employee: {
        select: {
          id: true,
          number: true,
          firstName: true,
          lastName: true,
          jobTitle: true,
          branchId: true,
          userId: true,
        },
      },
      reviewer: { select: { id: true, firstName: true, lastName: true } },
      goals: true,
    },
  });
  if (!r) throw notFound("Review");
  const self = await me(tx, ctx);
  const role = {
    own: r.employee.userId === ctx.userId,
    reviewer: !!self && self.id === r.reviewerEmployeeId,
    hr: manageAt(ctx, r.employee.branchId),
    viewer: viewAt(ctx, r.employee.branchId),
  };
  if (!role.own && !role.reviewer && !role.viewer) throw notFound("Review");
  return { r, role };
}

function step(status: ReviewStatus, s: ReviewStep, cycleOpen: boolean) {
  if (!cycleOpen) throw businessRuleViolation("CYCLE_NOT_OPEN", "The cycle is not open");
  if (!allowedSteps(status).includes(s))
    throw businessRuleViolation("REVIEW_STEP_NOT_ALLOWED", "This step is not possible now");
}

async function cycleGoals(tx: Tx, ctx: TenantContext, cycleId: string, employeeId: string) {
  return tx.performanceGoal.findMany({
    where: {
      organizationId: ctx.organizationId,
      cycleId,
      employeeId,
      status: { not: "CANCELLED" },
    },
    select: { id: true, title: true, weight: true, status: true, progress: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Ratings sent as `rating.<goalId>`. */
function goalRatings(raw: unknown): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const m = /^rating\.([0-9a-f-]{36})$/.exec(k);
    if (!m) continue;
    const r = optionalRating.safeParse(typeof v === "string" ? v : undefined);
    if (!r.success) throw validationFailed(r.error);
    out.set(m[1], r.data);
  }
  return out;
}

async function saveGoalRatingsInTx(
  tx: Tx,
  ctx: TenantContext,
  reviewId: string,
  ratings: Map<string, number | null>,
  goals: Array<{ id: string }>,
  field: "selfRating" | "managerRating",
) {
  for (const g of goals) {
    const value = ratings.get(g.id) ?? null;
    await tx.performanceReviewGoal.upsert({
      where: {
        organizationId_reviewId_goalId: {
          organizationId: ctx.organizationId,
          reviewId,
          goalId: g.id,
        },
      },
      create: { organizationId: ctx.organizationId, reviewId, goalId: g.id, [field]: value },
      update: { [field]: value },
    });
  }
}

export async function submitSelfReview(ctx: TenantContext, reviewId: string, rawInput: unknown) {
  const parsed = z.object({ comment: requiredText(3000) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { r, role } = await loadReview(tx, ctx, reviewId);
    if (!role.own) throw forbidden();
    step(r.status, "SELF", r.cycle.status === "OPEN");
    const goals = await cycleGoals(tx, ctx, r.cycleId, r.employeeId);
    await saveGoalRatingsInTx(tx, ctx, r.id, goalRatings(rawInput), goals, "selfRating");
    await tx.performanceReview.update({
      where: { id: r.id },
      data: { status: "SELF_DONE", selfComment: parsed.data.comment, selfSubmittedAt: new Date() },
    });
  });
}

export async function submitManagerReview(ctx: TenantContext, reviewId: string, rawInput: unknown) {
  const parsed = z
    .object({
      rating,
      strengths: requiredText(3000),
      improvements: requiredText(3000),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { r, role } = await loadReview(tx, ctx, reviewId);
    // The manager reviews; HR does when there is no manager on record.
    if (role.own || !(role.reviewer || (role.hr && !r.reviewerEmployeeId))) throw forbidden();
    step(r.status, "MANAGER", r.cycle.status === "OPEN");
    const goals = await cycleGoals(tx, ctx, r.cycleId, r.employeeId);
    const ratings = goalRatings(rawInput);
    const unrated = goals.filter((g) => !ratings.get(g.id));
    if (unrated.length)
      throw businessRuleViolation("REVIEW_GOALS_UNRATED", "Rate every goal of the cycle", {
        count: unrated.length,
      });
    await saveGoalRatingsInTx(tx, ctx, r.id, ratings, goals, "managerRating");
    await tx.performanceReview.update({
      where: { id: r.id },
      data: {
        status: "MANAGER_DONE",
        managerRating: parsed.data.rating,
        managerStrengths: parsed.data.strengths,
        managerImprovements: parsed.data.improvements,
        managerSubmittedAt: new Date(),
        managerSubmittedUserId: ctx.userId,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "performance_review.rated",
      entityType: "performance_review",
      entityId: r.id,
    });
  });
}

export async function acknowledgeReview(ctx: TenantContext, reviewId: string, rawInput: unknown) {
  const parsed = z.object({ comment: optionalText(2000) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { r, role } = await loadReview(tx, ctx, reviewId);
    if (!role.own) throw forbidden();
    step(r.status, "ACKNOWLEDGE", r.cycle.status === "OPEN");
    await tx.performanceReview.update({
      where: { id: r.id },
      data: {
        status: "ACKNOWLEDGED",
        employeeComment: parsed.data.comment,
        acknowledgedAt: new Date(),
      },
    });
  });
}

/** HR fixes the final rating: the manager's, or another with a reason. */
export async function finalizeReview(ctx: TenantContext, reviewId: string, rawInput: unknown) {
  const parsed = z
    .object({ finalRating: optionalRating, reason: optionalText(1000) })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { r, role } = await loadReview(tx, ctx, reviewId);
    if (!role.hr || role.own) throw forbidden();
    step(r.status, "FINALIZE", r.cycle.status === "OPEN");
    const final = parsed.data.finalRating ?? r.managerRating!;
    if (final !== r.managerRating && !parsed.data.reason)
      throw businessRuleViolation("REVIEW_CHANGE_NEEDS_REASON", "Say why the rating changes", {
        field: "reason",
      });
    await tx.performanceReview.update({
      where: { id: r.id },
      data: {
        status: "FINALIZED",
        finalRating: final,
        finalReason: parsed.data.reason,
        finalizedAt: new Date(),
        finalizedByUserId: ctx.userId,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "performance_review.finalized",
      entityType: "performance_review",
      entityId: r.id,
      changes: { changed: final !== r.managerRating },
    });
  });
}

export async function skipReview(ctx: TenantContext, reviewId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(300) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { r, role } = await loadReview(tx, ctx, reviewId);
    if (!role.hr || role.own) throw forbidden();
    step(r.status, "SKIP", r.cycle.status === "OPEN");
    await tx.performanceReview.update({
      where: { id: r.id },
      data: { status: "SKIPPED", skipReason: parsed.data.reason },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "performance_review.skipped",
      entityType: "performance_review",
      entityId: r.id,
      changes: { reason: parsed.data.reason },
    });
  });
}

/**
 * A review as the person may see it: the employee sees the manager's part
 * once it is submitted; the manager sees the self-review once submitted.
 */
export async function getReview(ctx: TenantContext, reviewId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { r, role } = await loadReview(tx, ctx, reviewId);
    const goals = await cycleGoals(tx, ctx, r.cycleId, r.employeeId);
    const ratings = new Map(r.goals.map((g) => [g.goalId, g]));
    const managerVisible =
      !role.own || ["MANAGER_DONE", "ACKNOWLEDGED", "FINALIZED"].includes(r.status);
    const selfVisible = role.own || r.status !== "NOT_STARTED";
    const rows = goals.map((g) => ({
      ...g,
      selfRating: selfVisible ? (ratings.get(g.id)?.selfRating ?? null) : null,
      managerRating: managerVisible ? (ratings.get(g.id)?.managerRating ?? null) : null,
    }));
    const steps = r.cycle.status === "OPEN" ? allowedSteps(r.status) : [];
    return {
      review: {
        id: r.id,
        status: r.status,
        cycle: {
          id: r.cycle.id,
          name: r.cycle.name,
          selfDueOn: day(r.cycle.selfDueOn),
          managerDueOn: day(r.cycle.managerDueOn),
        },
        employee: r.employee,
        reviewer: r.reviewer,
        selfComment: selfVisible ? r.selfComment : null,
        managerRating: managerVisible ? r.managerRating : null,
        managerStrengths: managerVisible ? r.managerStrengths : null,
        managerImprovements: managerVisible ? r.managerImprovements : null,
        employeeComment: r.employeeComment,
        finalRating: managerVisible ? r.finalRating : null,
        finalReason: managerVisible ? r.finalReason : null,
        skipReason: r.skipReason,
      },
      goals: rows,
      score: managerVisible
        ? goalScore(rows.map((g) => ({ rating: g.managerRating, weight: g.weight })))
        : null,
      can: {
        self: role.own && steps.includes("SELF"),
        manager:
          !role.own &&
          (role.reviewer || (role.hr && !r.reviewerEmployeeId)) &&
          steps.includes("MANAGER"),
        acknowledge: role.own && steps.includes("ACKNOWLEDGE"),
        finalize: role.hr && !role.own && steps.includes("FINALIZE"),
        skip: role.hr && !role.own && steps.includes("SKIP"),
      },
    };
  });
}

/** The signed-in person's goals, their reviews and the reviews they give. */
export async function myPerformance(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const self = await me(tx, ctx);
    if (!self) throw forbidden();
    const [goals, reviews, toGive] = await inSequence([
      tx.performanceGoal.findMany({
        where: { organizationId: ctx.organizationId, employeeId: self.id },
        include: { cycle: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      }),
      tx.performanceReview.findMany({
        where: {
          organizationId: ctx.organizationId,
          employeeId: self.id,
          cycle: { status: { not: "DRAFT" } },
        },
        include: { cycle: { select: { name: true, status: true, selfDueOn: true } } },
        orderBy: { cycle: { periodStart: "desc" } },
      }),
      tx.performanceReview.findMany({
        where: {
          organizationId: ctx.organizationId,
          reviewerEmployeeId: self.id,
          cycle: { status: "OPEN" },
        },
        include: {
          cycle: { select: { name: true, managerDueOn: true } },
          employee: { select: { number: true, firstName: true, lastName: true } },
        },
        orderBy: { employee: { number: "asc" } },
      }),
    ]);
    return { employeeId: self.id, goals, reviews, toGive };
  });
}

/** Reviews waiting for this person: their own self-review and those they give (Needs attention). */
export async function reviewsToDoInTx(tx: Tx, ctx: TenantContext) {
  const self = await me(tx, ctx);
  if (!self) return 0;
  return tx.performanceReview.count({
    where: {
      organizationId: ctx.organizationId,
      cycle: { status: "OPEN" },
      OR: [
        { employeeId: self.id, status: "NOT_STARTED" },
        { employeeId: self.id, status: "MANAGER_DONE" },
        { reviewerEmployeeId: self.id, status: { in: ["NOT_STARTED", "SELF_DONE"] } },
      ],
    },
  });
}
