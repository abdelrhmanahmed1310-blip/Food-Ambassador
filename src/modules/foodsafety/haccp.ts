import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString } from "@/lib/decimal";
import {
  accessibleScope,
  assertPermission,
  hasPermission,
  holdsAnyGrant,
} from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import {
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
import {
  checkpointWithinLimits,
  decide,
  planProblems,
  riskScore,
  type ControlClass,
  type TreeAnswers,
} from "./haccp-rules";

/**
 * HACCP plans (DECISIONS.md ADR-096). A plan lists the process steps of a
 * product or process, the hazards at each step with their assessment and
 * Codex decision-tree answers, and for each CCP or OPRP its critical limits,
 * monitoring, correction and verification. Monitoring can be tied to the
 * branches' temperature checkpoints, whose readings are then the plan's
 * evidence; a reading out of spec at such a checkpoint opens a HIGH
 * non-conformance linked to the control point. A plan is edited as a draft,
 * approved by someone other than its author with a review date, then fixed;
 * changes are made in a new version.
 */

const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

const yesNo = z
  .string()
  .optional()
  .transform((v) => (v === "yes" ? true : v === "no" ? false : null));
const optionalDecimal = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .pipe(
    decimalString({ maxScale: 3, min: "-999999", max: "999999", allowNegative: true }).optional(),
  );
const score = z
  .string()
  .transform((v) => Number(v))
  .refine((v) => Number.isInteger(v) && v >= 1 && v <= 5, { error: "invalidOption" });

const planSchema = z.object({
  code: z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .refine((v) => /^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(v), { error: "invalidCode" }),
  name: requiredText(160),
  branchId: optionalUuidSchema,
  scope: requiredText(2000),
  intendedUse: optionalText(1000),
  team: optionalText(500),
});
const planHeaderSchema = planSchema.omit({ code: true, branchId: true });
const stepSchema = z.object({ name: requiredText(160), description: optionalText(1000) });
const hazardSchema = z.object({
  stepId: uuidSchema,
  type: z.enum(["BIOLOGICAL", "CHEMICAL", "PHYSICAL", "ALLERGEN"], { error: "invalidOption" }),
  description: requiredText(500),
  likelihood: score,
  severity: score,
  significant: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  controlMeasures: optionalText(1000),
  q1: yesNo,
  q2: yesNo,
  q3: yesNo,
  q4: yesNo,
  /** Empty = take the decision tree's result. */
  classification: z
    .enum(["CCP", "OPRP", "PRP"], { error: "invalidOption" })
    .optional()
    .or(z.literal("").transform(() => undefined)),
  justification: optionalText(1000),
});
const controlPointSchema = z
  .object({
    criticalLimit: requiredText(500),
    minValue: optionalDecimal,
    maxValue: optionalDecimal,
    unit: optionalText(20),
    monitoring: requiredText(1000),
    frequency: requiredText(200),
    responsible: optionalText(200),
    correctiveAction: requiredText(1000),
    verification: requiredText(1000),
    recordsKept: optionalText(500),
  })
  .refine((v) => !v.minValue || !v.maxValue || new Decimal(v.minValue).lte(v.maxValue), {
    error: "invalidRange",
    path: ["maxValue"],
  });
const approveSchema = z.object({
  reviewDueOn: z
    .string()
    .transform((v) => v.trim())
    .refine(isCalendarDate, { error: "invalidDate" }),
});

// ─── Access ───

/** Who may see a plan: anyone with food safety access for an organization-wide plan, else at its branch. */
function canView(ctx: TenantContext, plan: { branchId: string | null }) {
  return plan.branchId
    ? hasPermission(ctx.grants, "foodsafety.view", { branchId: plan.branchId })
    : holdsAnyGrant(ctx.grants, "foodsafety.view");
}
function assertManage(ctx: TenantContext, plan: { branchId: string | null }) {
  if (plan.branchId) assertPermission(ctx.grants, "foodsafety.manage", { branchId: plan.branchId });
  else assertPermission(ctx.grants, "foodsafety.manage");
}

async function loadPlan(tx: Tx, ctx: TenantContext, planId: string, lock = false) {
  if (lock)
    await tx.$queryRaw`SELECT 1 FROM "haccp_plans" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${planId}::uuid FOR UPDATE`;
  const plan = await tx.haccpPlan.findFirst({
    where: { organizationId: ctx.organizationId, id: planId },
  });
  if (!plan || !canView(ctx, plan)) throw notFound("HACCP plan");
  return plan;
}

async function draftFor(tx: Tx, ctx: TenantContext, planId: string) {
  const plan = await loadPlan(tx, ctx, planId, true);
  assertManage(ctx, plan);
  if (plan.status !== "DRAFT")
    throw businessRuleViolation(
      "HACCP_PLAN_NOT_DRAFT",
      "Only a draft plan can be edited; start a new version",
    );
  return plan;
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  plan: { id: string; code: string; version: number },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `haccp_plan.${action}`,
    entityType: "haccp_plan",
    entityId: plan.id,
    changes: { code: plan.code, version: plan.version, ...changes },
  });
}

// ─── Plan ───

export async function createHaccpPlan(ctx: TenantContext, rawInput: unknown) {
  const parsed = planSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  assertManage(ctx, { branchId: v.branchId ?? null });
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      if (v.branchId) {
        const b = await tx.branch.findFirst({
          where: { organizationId: ctx.organizationId, id: v.branchId },
          select: { id: true },
        });
        if (!b) throw notFound("Branch");
      }
      const exists = await tx.haccpPlan.count({
        where: { organizationId: ctx.organizationId, code: v.code },
      });
      if (exists > 0)
        throw conflict("A plan with this code exists; start a new version of it", {
          field: "code",
          reason: "codeTaken",
        });
      const plan = await tx.haccpPlan.create({
        data: {
          organizationId: ctx.organizationId,
          code: v.code,
          name: v.name,
          branchId: v.branchId ?? null,
          scope: v.scope,
          intendedUse: v.intendedUse ?? null,
          team: v.team ?? null,
          createdByUserId: ctx.userId,
        },
        select: { id: true, code: true, version: true },
      });
      await audit(tx, ctx, plan, "created", { name: v.name, branchId: v.branchId ?? null });
      return plan;
    });
  } catch (error) {
    if (isUniqueViolation(error, "haccp_plans_organization_id_code_version_key"))
      throw conflict("A plan with this code exists", { field: "code", reason: "codeTaken" });
    throw error;
  }
}

export async function updateHaccpPlan(ctx: TenantContext, planId: string, rawInput: unknown) {
  const parsed = planHeaderSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await draftFor(tx, ctx, planId);
    await tx.haccpPlan.update({
      where: { id: plan.id },
      data: {
        name: v.name,
        scope: v.scope,
        intendedUse: v.intendedUse ?? null,
        team: v.team ?? null,
      },
    });
    await audit(tx, ctx, plan, "updated", v);
  });
}

// ─── Steps ───

export async function addHaccpStep(ctx: TenantContext, planId: string, rawInput: unknown) {
  const parsed = stepSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await draftFor(tx, ctx, planId);
    const last = await tx.haccpStep.aggregate({
      where: { organizationId: ctx.organizationId, planId: plan.id },
      _max: { position: true },
    });
    const step = await tx.haccpStep.create({
      data: {
        organizationId: ctx.organizationId,
        planId: plan.id,
        position: (last._max.position ?? 0) + 1,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
      },
      select: { id: true },
    });
    await audit(tx, ctx, plan, "step_added", parsed.data);
    return step;
  });
}

export async function removeHaccpStep(ctx: TenantContext, planId: string, stepId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await draftFor(tx, ctx, planId);
    const removed = await tx.haccpStep.deleteMany({
      where: { organizationId: ctx.organizationId, planId: plan.id, id: stepId },
    });
    if (removed.count === 0) throw notFound("Step");
    await audit(tx, ctx, plan, "step_removed", { stepId });
  });
}

// ─── Hazards ───

function hazardData(v: z.infer<typeof hazardSchema>) {
  const answers: TreeAnswers = { q1: v.q1, q2: v.q2, q3: v.q3, q4: v.q4 };
  const outcome = decide(v.significant, answers);
  // Answers past where the tree stopped are not kept.
  const kept: TreeAnswers = { q1: null, q2: null, q3: null, q4: null };
  for (const q of outcome.asked) kept[q] = answers[q];
  const treeResult: ControlClass | null =
    outcome.result === "CCP" || outcome.result === "OPRP" || outcome.result === "PRP"
      ? outcome.result
      : null;
  const classification: ControlClass =
    v.classification ?? treeResult ?? (v.significant ? "OPRP" : "PRP");
  if (treeResult && classification !== treeResult && !v.justification)
    throw businessRuleViolation(
      "CLASSIFICATION_JUSTIFICATION_REQUIRED",
      "Say why this hazard is classified differently from the decision tree",
      { field: "justification", tree: treeResult },
    );
  return {
    type: v.type,
    description: v.description,
    likelihood: v.likelihood,
    severity: v.severity,
    significant: v.significant,
    controlMeasures: v.controlMeasures ?? null,
    ...kept,
    treeResult,
    classification,
    justification: classification === treeResult ? null : (v.justification ?? null),
  };
}

export async function addHaccpHazard(ctx: TenantContext, planId: string, rawInput: unknown) {
  const parsed = hazardSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const data = hazardData(parsed.data);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await draftFor(tx, ctx, planId);
    const step = await tx.haccpStep.findFirst({
      where: { organizationId: ctx.organizationId, planId: plan.id, id: parsed.data.stepId },
    });
    if (!step) throw notFound("Step");
    const hazard = await tx.haccpHazard.create({
      data: { ...data, organizationId: ctx.organizationId, planId: plan.id, stepId: step.id },
      select: { id: true, classification: true, treeResult: true },
    });
    await audit(tx, ctx, plan, "hazard_added", { step: step.name, ...data });
    return hazard;
  });
}

export async function updateHaccpHazard(
  ctx: TenantContext,
  planId: string,
  hazardId: string,
  rawInput: unknown,
) {
  const parsed = hazardSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const data = hazardData(parsed.data);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await draftFor(tx, ctx, planId);
    const hazard = await tx.haccpHazard.findFirst({
      where: { organizationId: ctx.organizationId, planId: plan.id, id: hazardId },
      include: { controlPoint: { select: { id: true } } },
    });
    if (!hazard) throw notFound("Hazard");
    // A PRP has no control point of its own.
    if (data.classification === "PRP" && hazard.controlPoint)
      await tx.haccpControlPoint.delete({ where: { id: hazard.controlPoint.id } });
    await tx.haccpHazard.update({
      where: { id: hazard.id },
      data: { ...data, stepId: parsed.data.stepId },
    });
    await audit(tx, ctx, plan, "hazard_updated", { hazardId, ...data });
  });
}

export async function removeHaccpHazard(ctx: TenantContext, planId: string, hazardId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await draftFor(tx, ctx, planId);
    const removed = await tx.haccpHazard.deleteMany({
      where: { organizationId: ctx.organizationId, planId: plan.id, id: hazardId },
    });
    if (removed.count === 0) throw notFound("Hazard");
    await audit(tx, ctx, plan, "hazard_removed", { hazardId });
  });
}

// ─── Control points ───

export async function saveHaccpControlPoint(
  ctx: TenantContext,
  planId: string,
  hazardId: string,
  rawInput: unknown,
) {
  const parsed = controlPointSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await draftFor(tx, ctx, planId);
    const hazard = await tx.haccpHazard.findFirst({
      where: { organizationId: ctx.organizationId, planId: plan.id, id: hazardId },
      include: { controlPoint: { include: { checkpoints: { include: { checkpoint: true } } } } },
    });
    if (!hazard) throw notFound("Hazard");
    if (hazard.classification === "PRP")
      throw businessRuleViolation(
        "PRP_HAS_NO_CONTROL_POINT",
        "Prerequisite programmes have no critical limits",
      );
    const data = {
      criticalLimit: v.criticalLimit,
      minValue: v.minValue ?? null,
      maxValue: v.maxValue ?? null,
      unit: v.unit ?? null,
      monitoring: v.monitoring,
      frequency: v.frequency,
      responsible: v.responsible ?? null,
      correctiveAction: v.correctiveAction,
      verification: v.verification,
      recordsKept: v.recordsKept ?? null,
    };
    // Linked checkpoints must stay inside the (new) limits.
    for (const link of hazard.controlPoint?.checkpoints ?? []) assertFits(link.checkpoint, data);
    const cp = await tx.haccpControlPoint.upsert({
      where: {
        organizationId_hazardId: { organizationId: ctx.organizationId, hazardId: hazard.id },
      },
      create: { ...data, organizationId: ctx.organizationId, planId: plan.id, hazardId: hazard.id },
      update: data,
      select: { id: true },
    });
    await audit(tx, ctx, plan, "control_point_saved", { hazardId, ...v });
    return cp;
  });
}

const isCelsius = (unit: string | null) => !unit || /^°?\s*c$/i.test(unit.trim());

function assertFits(
  checkpoint: { code: string; minCelsius: unknown; maxCelsius: unknown },
  limits: { minValue: string | null; maxValue: string | null; unit: string | null },
) {
  if (limits.minValue === null && limits.maxValue === null) return;
  if (!isCelsius(limits.unit))
    throw businessRuleViolation(
      "CHECKPOINT_UNIT_MISMATCH",
      "Temperature checkpoints can only monitor limits in °C",
      { field: "unit" },
    );
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(String(v)));
  if (
    !checkpointWithinLimits(
      { min: n(checkpoint.minCelsius), max: n(checkpoint.maxCelsius) },
      { min: n(limits.minValue), max: n(limits.maxValue) },
    )
  )
    throw businessRuleViolation(
      "CHECKPOINT_OUTSIDE_LIMITS",
      "The checkpoint's limits are wider than the critical limits",
      { checkpoint: checkpoint.code },
    );
}

export async function linkHaccpCheckpoint(
  ctx: TenantContext,
  planId: string,
  controlPointId: string,
  rawInput: unknown,
) {
  const parsed = z.object({ checkpointId: uuidSchema }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await draftFor(tx, ctx, planId);
    const cp = await tx.haccpControlPoint.findFirst({
      where: { organizationId: ctx.organizationId, planId: plan.id, id: controlPointId },
    });
    if (!cp) throw notFound("Control point");
    const checkpoint = await tx.safetyCheckpoint.findFirst({
      where: {
        organizationId: ctx.organizationId,
        id: parsed.data.checkpointId,
        archivedAt: null,
        ...(plan.branchId ? { branchId: plan.branchId } : {}),
      },
    });
    if (
      !checkpoint ||
      !hasPermission(ctx.grants, "foodsafety.view", { branchId: checkpoint.branchId })
    )
      throw notFound("Checkpoint");
    assertFits(checkpoint, {
      minValue: cp.minValue?.toString() ?? null,
      maxValue: cp.maxValue?.toString() ?? null,
      unit: cp.unit,
    });
    await tx.haccpControlPointCheckpoint.upsert({
      where: {
        organizationId_controlPointId_checkpointId: {
          organizationId: ctx.organizationId,
          controlPointId: cp.id,
          checkpointId: checkpoint.id,
        },
      },
      create: {
        organizationId: ctx.organizationId,
        controlPointId: cp.id,
        checkpointId: checkpoint.id,
      },
      update: {},
    });
    await audit(tx, ctx, plan, "checkpoint_linked", {
      controlPointId,
      checkpoint: checkpoint.code,
    });
  });
}

export async function unlinkHaccpCheckpoint(
  ctx: TenantContext,
  planId: string,
  controlPointId: string,
  checkpointId: string,
) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await draftFor(tx, ctx, planId);
    await tx.haccpControlPointCheckpoint.deleteMany({
      where: {
        organizationId: ctx.organizationId,
        controlPointId,
        checkpointId,
        controlPoint: { planId: plan.id },
      },
    });
    await audit(tx, ctx, plan, "checkpoint_unlinked", { controlPointId, checkpointId });
  });
}

// ─── Approval and versions ───

async function problemsOf(tx: Tx, ctx: TenantContext, planId: string) {
  const [steps, hazards] = [
    await tx.haccpStep.count({ where: { organizationId: ctx.organizationId, planId } }),
    await tx.haccpHazard.findMany({
      where: { organizationId: ctx.organizationId, planId },
      include: { controlPoint: { select: { id: true } } },
    }),
  ];
  return planProblems({
    steps,
    hazards: hazards.map((h) => ({
      id: h.id,
      significant: h.significant,
      answers: { q1: h.q1, q2: h.q2, q3: h.q3, q4: h.q4 },
      classification: h.classification,
      hasControlPoint: h.controlPoint !== null,
    })),
  });
}

/** Approve a complete draft (someone other than its author); an earlier approved version is superseded. */
export async function approveHaccpPlan(ctx: TenantContext, planId: string, rawInput: unknown) {
  const parsed = approveSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await draftFor(tx, ctx, planId);
    if (plan.createdByUserId === ctx.userId)
      throw businessRuleViolation(
        "HACCP_SELF_APPROVAL",
        "A HACCP plan must be approved by someone other than its author",
      );
    if (parsed.data.reviewDueOn <= businessDate(ctx.timeZone))
      throw businessRuleViolation("REVIEW_DATE_PAST", "The review date must be in the future", {
        field: "reviewDueOn",
      });
    const problems = await problemsOf(tx, ctx, plan.id);
    if (problems.length > 0)
      throw businessRuleViolation("HACCP_PLAN_INCOMPLETE", "The plan is not complete", {
        problems: problems.map((p) => p.code).join(","),
      });
    const now = new Date();
    const previous = await tx.haccpPlan.updateMany({
      where: { organizationId: ctx.organizationId, code: plan.code, status: "APPROVED" },
      data: { status: "SUPERSEDED", supersededAt: now },
    });
    await tx.haccpPlan.update({
      where: { id: plan.id },
      data: {
        status: "APPROVED",
        approvedAt: now,
        approvedByUserId: ctx.userId,
        reviewDueOn: asDate(parsed.data.reviewDueOn),
      },
    });
    await audit(tx, ctx, plan, "approved", {
      reviewDueOn: parsed.data.reviewDueOn,
      superseded: previous.count,
    });
  });
}

/** A new draft version of an approved plan, copied in full; the approved one stays in force until the new one is approved. */
export async function newHaccpPlanVersion(ctx: TenantContext, planId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await loadPlan(tx, ctx, planId, true);
    assertManage(ctx, plan);
    if (plan.status !== "APPROVED")
      throw businessRuleViolation(
        "HACCP_PLAN_NOT_APPROVED",
        "Only the approved version can be revised",
      );
    const draft = await tx.haccpPlan.count({
      where: { organizationId: ctx.organizationId, code: plan.code, status: "DRAFT" },
    });
    if (draft > 0)
      throw businessRuleViolation(
        "HACCP_DRAFT_EXISTS",
        "A new version of this plan is already being prepared",
      );
    const latest = await tx.haccpPlan.aggregate({
      where: { organizationId: ctx.organizationId, code: plan.code },
      _max: { version: true },
    });
    const copy = await tx.haccpPlan.create({
      data: {
        organizationId: ctx.organizationId,
        code: plan.code,
        version: (latest._max.version ?? plan.version) + 1,
        name: plan.name,
        branchId: plan.branchId,
        scope: plan.scope,
        intendedUse: plan.intendedUse,
        team: plan.team,
        createdByUserId: ctx.userId,
      },
      select: { id: true, code: true, version: true },
    });
    const steps = await tx.haccpStep.findMany({
      where: { organizationId: ctx.organizationId, planId: plan.id },
      include: {
        hazards: { include: { controlPoint: { include: { checkpoints: true } } } },
      },
      orderBy: { position: "asc" },
    });
    for (const s of steps) {
      const step = await tx.haccpStep.create({
        data: {
          organizationId: ctx.organizationId,
          planId: copy.id,
          position: s.position,
          name: s.name,
          description: s.description,
        },
        select: { id: true },
      });
      for (const h of s.hazards) {
        const hazard = await tx.haccpHazard.create({
          data: {
            organizationId: ctx.organizationId,
            planId: copy.id,
            stepId: step.id,
            type: h.type,
            description: h.description,
            likelihood: h.likelihood,
            severity: h.severity,
            significant: h.significant,
            controlMeasures: h.controlMeasures,
            q1: h.q1,
            q2: h.q2,
            q3: h.q3,
            q4: h.q4,
            treeResult: h.treeResult,
            classification: h.classification,
            justification: h.justification,
          },
          select: { id: true },
        });
        const c = h.controlPoint;
        if (c) {
          const cp = await tx.haccpControlPoint.create({
            data: {
              organizationId: ctx.organizationId,
              planId: copy.id,
              hazardId: hazard.id,
              criticalLimit: c.criticalLimit,
              minValue: c.minValue,
              maxValue: c.maxValue,
              unit: c.unit,
              monitoring: c.monitoring,
              frequency: c.frequency,
              responsible: c.responsible,
              correctiveAction: c.correctiveAction,
              verification: c.verification,
              recordsKept: c.recordsKept,
            },
            select: { id: true },
          });
          if (c.checkpoints.length > 0)
            await tx.haccpControlPointCheckpoint.createMany({
              data: c.checkpoints.map((k) => ({
                organizationId: ctx.organizationId,
                controlPointId: cp.id,
                checkpointId: k.checkpointId,
              })),
            });
        }
      }
    }
    await audit(tx, ctx, copy, "version_started", { from: plan.version });
    return copy;
  });
}

// ─── Queries ───

function visibleWhere(ctx: TenantContext): Prisma.HaccpPlanWhereInput {
  const scope = accessibleScope(ctx.grants, "foodsafety.view");
  if (scope.all) return {};
  return { OR: [{ branchId: null }, { branchId: { in: scope.branchIds } }] };
}

export async function listHaccpPlans(ctx: TenantContext) {
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) throw forbidden();
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.haccpPlan.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { not: "SUPERSEDED" },
        ...visibleWhere(ctx),
      },
      select: {
        id: true,
        code: true,
        version: true,
        name: true,
        status: true,
        reviewDueOn: true,
        approvedAt: true,
        branch: { select: { code: true, name: true } },
        _count: { select: { steps: true, controlPoints: true } },
      },
      orderBy: [{ code: "asc" }, { version: "desc" }],
    }),
  );
}

/** The plan page: steps with hazards and control points, readiness, versions and monitoring evidence. */
export async function getHaccpPlan(ctx: TenantContext, planId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await loadPlan(tx, ctx, planId);
    const today = businessDate(ctx.timeZone);
    const since = new Date(`${addDays(today, -30)}T00:00:00Z`);
    const [steps, versions, branch, users] = [
      await tx.haccpStep.findMany({
        where: { organizationId: ctx.organizationId, planId: plan.id },
        include: {
          hazards: {
            include: {
              controlPoint: {
                include: {
                  checkpoints: {
                    include: {
                      checkpoint: {
                        select: {
                          id: true,
                          code: true,
                          name: true,
                          minCelsius: true,
                          maxCelsius: true,
                          branch: { select: { code: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
            orderBy: { id: "asc" },
          },
        },
        orderBy: { position: "asc" },
      }),
      await tx.haccpPlan.findMany({
        where: { organizationId: ctx.organizationId, code: plan.code },
        select: { id: true, version: true, status: true, approvedAt: true },
        orderBy: { version: "desc" },
      }),
      plan.branchId
        ? await tx.branch.findFirst({
            where: { organizationId: ctx.organizationId, id: plan.branchId },
            select: { id: true, code: true, name: true },
          })
        : null,
      await tx.user.findMany({
        where: {
          id: { in: [plan.createdByUserId, plan.approvedByUserId].filter((x): x is string => !!x) },
        },
        select: { id: true, name: true },
      }),
    ];
    const checkpointIds = [
      ...new Set(
        steps.flatMap((s) =>
          s.hazards.flatMap((h) => h.controlPoint?.checkpoints.map((c) => c.checkpointId) ?? []),
        ),
      ),
    ];
    const [readings, deviations] = [
      checkpointIds.length
        ? await tx.foodSafetyRecord.groupBy({
            by: ["checkpointId", "inSpec"],
            where: {
              organizationId: ctx.organizationId,
              checkpointId: { in: checkpointIds },
              recordedAt: { gte: since },
            },
            _count: { _all: true },
            _max: { recordedAt: true },
          })
        : [],
      await tx.nonConformance.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: { not: "CLOSED" },
          controlPoint: { plan: { code: plan.code } },
        },
        select: { id: true, number: true, title: true, controlPointId: true, raisedAt: true },
        orderBy: { raisedAt: "desc" },
        take: 20,
      }),
    ];
    const evidence = (checkpointId: string) => {
      const rows = readings.filter((r) => r.checkpointId === checkpointId);
      const count = (inSpec: boolean) => rows.find((r) => r.inSpec === inSpec)?._count._all ?? 0;
      const last = rows.reduce<Date | null>(
        (m, r) => (r._max.recordedAt && (!m || r._max.recordedAt > m) ? r._max.recordedAt : m),
        null,
      );
      return { readings: count(true) + count(false), outOfSpec: count(false), lastReading: last };
    };
    const name = (id: string | null) => users.find((u) => u.id === id)?.name ?? null;
    const problems = plan.status === "DRAFT" ? await problemsOf(tx, ctx, plan.id) : [];
    return {
      plan: {
        ...plan,
        branch,
        createdBy: name(plan.createdByUserId),
        approvedBy: name(plan.approvedByUserId),
        reviewOverdue:
          plan.status === "APPROVED" &&
          !!plan.reviewDueOn &&
          plan.reviewDueOn.toISOString().slice(0, 10) <= today,
      },
      steps: steps.map((s) => ({
        ...s,
        hazards: s.hazards.map((h) => ({
          ...h,
          risk: riskScore(h.likelihood, h.severity),
          controlPoint: h.controlPoint && {
            ...h.controlPoint,
            checkpoints: h.controlPoint.checkpoints.map((c) => ({
              ...c.checkpoint,
              ...evidence(c.checkpointId),
            })),
          },
        })),
      })),
      problems,
      versions,
      deviations,
      can: {
        edit: plan.status === "DRAFT" && canManage(ctx, plan),
        approve:
          plan.status === "DRAFT" && canManage(ctx, plan) && plan.createdByUserId !== ctx.userId,
        newVersion:
          plan.status === "APPROVED" &&
          canManage(ctx, plan) &&
          !versions.some((v) => v.status === "DRAFT"),
      },
    };
  });
}

function canManage(ctx: TenantContext, plan: { branchId: string | null }) {
  return plan.branchId
    ? hasPermission(ctx.grants, "foodsafety.manage", { branchId: plan.branchId })
    : hasPermission(ctx.grants, "foodsafety.manage");
}

/** Checkpoints a control point of this plan may monitor. */
export async function checkpointsForPlan(ctx: TenantContext, plan: { branchId: string | null }) {
  const scope = accessibleScope(ctx.grants, "foodsafety.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.safetyCheckpoint.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(plan.branchId
          ? { branchId: plan.branchId }
          : scope.all
            ? {}
            : { branchId: { in: scope.branchIds } }),
      },
      select: {
        id: true,
        code: true,
        name: true,
        minCelsius: true,
        maxCelsius: true,
        branch: { select: { code: true } },
      },
      orderBy: [{ branch: { code: "asc" } }, { code: "asc" }],
    }),
  );
}

/**
 * The control points of approved plans monitored at a checkpoint (CCPs
 * first): a reading out of spec there is a deviation from the plan.
 */
export async function controlPointsAtCheckpoint(tx: Tx, ctx: TenantContext, checkpointId: string) {
  const rows = await tx.haccpControlPointCheckpoint.findMany({
    where: {
      organizationId: ctx.organizationId,
      checkpointId,
      controlPoint: { plan: { status: "APPROVED" } },
    },
    select: {
      controlPoint: {
        select: {
          id: true,
          criticalLimit: true,
          correctiveAction: true,
          plan: { select: { code: true, version: true } },
          hazard: { select: { classification: true, description: true } },
        },
      },
    },
  });
  return rows
    .map((r) => r.controlPoint)
    .sort(
      (a, b) =>
        (a.hazard.classification === "CCP" ? -1 : 0) - (b.hazard.classification === "CCP" ? -1 : 0),
    );
}

/** Approved plans whose review date has come (attention list). */
export async function haccpReviewsDue(tx: Tx, ctx: TenantContext) {
  return tx.haccpPlan.count({
    where: {
      organizationId: ctx.organizationId,
      status: "APPROVED",
      reviewDueOn: { lte: new Date(`${businessDate(ctx.timeZone)}T00:00:00Z`) },
      ...visibleWhere(ctx),
    },
  });
}
