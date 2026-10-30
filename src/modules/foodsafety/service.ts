import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal, toDecimal } from "@/lib/decimal";
import {
  accessibleScope,
  assertPermission,
  hasPermission,
  holdsAnyGrant,
} from "@/modules/access/authorize";
import type { Permission } from "@/modules/access/permissions";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
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
import { automaticSeverity, withinLimits } from "./rules";
import {
  checklistItemSchema,
  checkpointSchema,
  recordSchema,
  runSchema,
  templateSchema,
} from "./schemas";

/**
 * Food safety records and checklists (DECISIONS.md ADR-035). Branch-scoped
 * permissions: `foodsafety.view`, `foodsafety.record`, `foodsafety.manage`.
 * Out-of-spec records and failed checklists open a non-conformance in the
 * same transaction.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());

/** Held in at least one branch (lists are then filtered to those branches). */
export function requireAnywhere(ctx: TenantContext, permission: Permission) {
  if (!holdsAnyGrant(ctx.grants, permission)) throw forbidden();
}

export async function loadBranch(
  tx: Tx,
  ctx: TenantContext,
  branchId: string,
  permission: Permission,
) {
  const branch = await tx.branch.findFirst({
    where: { organizationId: ctx.organizationId, id: branchId },
    select: { id: true, code: true, name: true, timeZone: true, archivedAt: true },
  });
  if (!branch || !hasPermission(ctx.grants, "foodsafety.view", { branchId: branch.id }))
    throw notFound("Branch");
  assertPermission(ctx.grants, permission, { branchId: branch.id });
  return branch;
}

/** Branch filter for lists: branches where the user holds `permission`. */
export function branchScope(ctx: TenantContext, permission: Permission = "foodsafety.view") {
  const scope = accessibleScope(ctx.grants, permission);
  return scope.all ? {} : { branchId: { in: scope.branchIds } };
}

export async function openNonConformanceInTx(
  tx: Tx,
  ctx: TenantContext,
  input: {
    branchId: string;
    timeZone: string | null;
    title: string;
    description: string;
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    source: "MANUAL" | "RECORD" | "CHECKLIST";
  },
) {
  const year = Number(businessDate(input.timeZone ?? ctx.timeZone).slice(0, 4));
  const number = await nextDocumentNumber(tx, ctx.organizationId, "NC", year);
  const nc = await tx.nonConformance.create({
    data: {
      organizationId: ctx.organizationId,
      number,
      branchId: input.branchId,
      title: input.title,
      description: input.description,
      severity: input.severity,
      source: input.source,
      raisedByUserId: ctx.userId,
    },
    select: { id: true, number: true },
  });
  await recordAudit(tx, actorOf(ctx), {
    action: "non_conformance.raised",
    entityType: "non_conformance",
    entityId: nc.id,
    changes: { number, source: input.source, severity: input.severity, title: input.title },
  });
  return nc;
}

// ─── Checkpoints ───

export async function createCheckpoint(ctx: TenantContext, rawInput: unknown) {
  const parsed = checkpointSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const branch = await loadBranch(tx, ctx, input.branchId, "foodsafety.manage");
      const cp = await tx.safetyCheckpoint.create({
        data: { organizationId: ctx.organizationId, ...input, branchId: branch.id },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "safety_checkpoint.created",
        entityType: "safety_checkpoint",
        entityId: cp.id,
        changes: input,
      });
      return cp;
    });
  } catch (error) {
    if (isUniqueViolation(error, "safety_checkpoints_organization_id_branch_id_code_key"))
      throw conflict("A checkpoint with this code exists in the branch", {
        reason: "duplicate",
        field: "code",
      });
    throw error;
  }
}

export async function setCheckpointArchived(
  ctx: TenantContext,
  checkpointId: string,
  archived: boolean,
) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const cp = await tx.safetyCheckpoint.findFirst({
      where: { organizationId: ctx.organizationId, id: checkpointId },
    });
    if (!cp) throw notFound("Checkpoint");
    await loadBranch(tx, ctx, cp.branchId, "foodsafety.manage");
    await tx.safetyCheckpoint.update({
      where: { id: cp.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "safety_checkpoint.archived" : "safety_checkpoint.restored",
      entityType: "safety_checkpoint",
      entityId: cp.id,
      changes: { code: cp.code },
    });
  });
}

export async function listCheckpoints(
  ctx: TenantContext,
  options: { includeArchived?: boolean } = {},
) {
  requireAnywhere(ctx, "foodsafety.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.safetyCheckpoint.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...branchScope(ctx),
        ...(options.includeArchived ? {} : { archivedAt: null }),
      },
      include: {
        branch: { select: { code: true, name: true } },
        records: {
          orderBy: { recordedAt: "desc" },
          take: 1,
          select: { recordedAt: true, valueCelsius: true, inSpec: true },
        },
      },
      orderBy: [{ branch: { code: "asc" } }, { code: "asc" }],
    });
    return rows.map(({ records, ...cp }) => ({ ...cp, last: records[0] ?? null }));
  });
}

// ─── Records ───

/**
 * Record a reading or check. Temperatures are judged against the
 * checkpoint's limits now (copied onto the record); out of spec (or failed)
 * needs a corrective note and opens a non-conformance.
 */
export async function addRecord(ctx: TenantContext, rawInput: unknown) {
  const parsed = recordSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    let branchId: string;
    let limits: { min: Decimal | null; max: Decimal | null } = { min: null, max: null };
    let checkpointName: string | null = null;
    if (input.type === "TEMPERATURE") {
      const cp = await tx.safetyCheckpoint.findFirst({
        where: { organizationId: ctx.organizationId, id: input.checkpointId as string },
      });
      if (!cp) throw notFound("Checkpoint");
      if (cp.archivedAt)
        throw businessRuleViolation("CHECKPOINT_ARCHIVED", "The checkpoint is archived", {
          field: "checkpointId",
        });
      branchId = cp.branchId;
      limits = {
        min: cp.minCelsius ? dec(cp.minCelsius) : null,
        max: cp.maxCelsius ? dec(cp.maxCelsius) : null,
      };
      checkpointName = `${cp.code} — ${cp.name}`;
    } else {
      branchId = input.branchId as string;
    }
    const branch = await loadBranch(tx, ctx, branchId, "foodsafety.record");
    if (branch.archivedAt) throw businessRuleViolation("BRANCH_ARCHIVED", "The branch is archived");
    const inSpec =
      input.type === "TEMPERATURE"
        ? withinLimits(toDecimal(input.valueCelsius as string), limits.min, limits.max)
        : input.passed === "yes";
    if (!inSpec && !input.correctiveNote)
      throw businessRuleViolation("CORRECTIVE_NOTE_REQUIRED", "Say what was done about it", {
        field: "correctiveNote",
      });
    const record = await tx.foodSafetyRecord.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: branch.id,
        checkpointId: input.type === "TEMPERATURE" ? (input.checkpointId as string) : null,
        type: input.type,
        valueCelsius: input.type === "TEMPERATURE" ? input.valueCelsius : null,
        minCelsius: limits.min?.toFixed() ?? null,
        maxCelsius: limits.max?.toFixed() ?? null,
        passed: input.type === "TEMPERATURE" ? null : input.passed === "yes",
        inSpec,
        note: input.note,
        correctiveNote: input.correctiveNote,
        recordedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    let nonConformance: { id: string; number: string } | null = null;
    if (!inSpec) {
      nonConformance = await openNonConformanceInTx(tx, ctx, {
        branchId: branch.id,
        timeZone: branch.timeZone,
        title:
          input.type === "TEMPERATURE"
            ? `Temperature out of range: ${checkpointName} ${input.valueCelsius} °C`
            : `Failed ${input.type.toLowerCase().replace("_", " ")} check`,
        description: [input.note, `Immediate action: ${input.correctiveNote}`]
          .filter(Boolean)
          .join("\n"),
        severity: automaticSeverity(1),
        source: "RECORD",
      });
      await tx.foodSafetyRecord.update({
        where: { id: record.id },
        data: { nonConformanceId: nonConformance.id },
      });
    }
    await recordAudit(tx, actorOf(ctx), {
      action: "food_safety_record.added",
      entityType: "food_safety_record",
      entityId: record.id,
      changes: { type: input.type, valueCelsius: input.valueCelsius, passed: input.passed, inSpec },
    });
    return { id: record.id, inSpec, nonConformance };
  });
}

export async function listRecords(
  ctx: TenantContext,
  filters: { branchId?: string; type?: string; outOfSpec?: boolean; take?: number } = {},
) {
  requireAnywhere(ctx, "foodsafety.view");
  const where: Prisma.FoodSafetyRecordWhereInput = {
    organizationId: ctx.organizationId,
    ...branchScope(ctx),
    ...(filters.branchId ? { AND: [{ branchId: filters.branchId }] } : {}),
    ...(filters.type ? { type: filters.type as never } : {}),
    ...(filters.outOfSpec ? { inSpec: false } : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.foodSafetyRecord.findMany({
      where,
      include: {
        branch: { select: { code: true } },
        checkpoint: { select: { code: true, name: true } },
        nonConformance: { select: { id: true, number: true } },
      },
      orderBy: { recordedAt: "desc" },
      take: filters.take ?? 100,
    });
    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.recordedByUserId))] } },
      select: { id: true, name: true },
    });
    return rows.map((r) => ({
      ...r,
      recordedBy: users.find((u) => u.id === r.recordedByUserId)?.name ?? null,
    }));
  });
}

// ─── Checklists ───

export async function createTemplate(ctx: TenantContext, rawInput: unknown) {
  requireAnywhere(ctx, "foodsafety.manage");
  const parsed = templateSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const tpl = await tx.checklistTemplate.create({
      data: { organizationId: ctx.organizationId, ...parsed.data },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "checklist_template.created",
      entityType: "checklist_template",
      entityId: tpl.id,
      changes: parsed.data,
    });
    return tpl;
  });
}

async function loadTemplate(tx: Tx, ctx: TenantContext, templateId: string) {
  const tpl = await tx.checklistTemplate.findFirst({
    where: { organizationId: ctx.organizationId, id: templateId },
    include: { items: { where: { archivedAt: null }, orderBy: { position: "asc" } } },
  });
  if (!tpl) throw notFound("Checklist");
  return tpl;
}

export async function addChecklistItem(ctx: TenantContext, templateId: string, rawInput: unknown) {
  requireAnywhere(ctx, "foodsafety.manage");
  const parsed = checklistItemSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "checklist_templates" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${templateId}::uuid FOR UPDATE`;
    const tpl = await loadTemplate(tx, ctx, templateId);
    const last = await tx.checklistItem.findFirst({
      where: { organizationId: ctx.organizationId, templateId: tpl.id },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    await tx.checklistItem.create({
      data: {
        organizationId: ctx.organizationId,
        templateId: tpl.id,
        position: (last?.position ?? 0) + 1,
        ...parsed.data,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "checklist_template.item_added",
      entityType: "checklist_template",
      entityId: tpl.id,
      changes: parsed.data,
    });
  });
}

/** Items are retired, not deleted: past runs keep their own copy. */
export async function removeChecklistItem(ctx: TenantContext, templateId: string, itemId: string) {
  requireAnywhere(ctx, "foodsafety.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const tpl = await loadTemplate(tx, ctx, templateId);
    const item = tpl.items.find((i) => i.id === itemId);
    if (!item) throw notFound("Checklist item");
    await tx.checklistItem.update({ where: { id: item.id }, data: { archivedAt: new Date() } });
    await recordAudit(tx, actorOf(ctx), {
      action: "checklist_template.item_removed",
      entityType: "checklist_template",
      entityId: tpl.id,
      changes: { text: item.text },
    });
  });
}

export async function listTemplates(ctx: TenantContext) {
  requireAnywhere(ctx, "foodsafety.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.checklistTemplate.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      include: { _count: { select: { items: { where: { archivedAt: null } }, runs: true } } },
      orderBy: { name: "asc" },
    }),
  );
}

export async function getTemplate(ctx: TenantContext, templateId: string) {
  requireAnywhere(ctx, "foodsafety.view");
  return withTenantTx(ctx.organizationId, (tx) => loadTemplate(tx, ctx, templateId));
}

/**
 * Complete a checklist in one go. Every current item must be answered;
 * NUMBER answers are judged against the item's range; any failure opens one
 * non-conformance for the run.
 */
export async function completeChecklist(ctx: TenantContext, templateId: string, rawInput: unknown) {
  const parsed = runSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await loadBranch(tx, ctx, input.branchId, "foodsafety.record");
    const tpl = await loadTemplate(tx, ctx, templateId);
    if (tpl.items.length === 0)
      throw businessRuleViolation("CHECKLIST_EMPTY", "The checklist has no items");
    const answers = tpl.items.map((item) => {
      const index = input.answers.findIndex((a) => a.itemId === item.id);
      const a = input.answers[index];
      const field = item.kind === "YES_NO" ? "yes" : "value";
      if (!a || (item.kind === "YES_NO" ? !a.yes : a.value === undefined))
        throw businessRuleViolation("CHECKLIST_ITEM_UNANSWERED", "Answer every item", {
          field: `answers.${index < 0 ? tpl.items.indexOf(item) : index}.${field}`,
        });
      const ok =
        item.kind === "YES_NO"
          ? a.yes === "yes"
          : withinLimits(
              toDecimal(a.value as string),
              item.minValue ? dec(item.minValue) : null,
              item.maxValue ? dec(item.maxValue) : null,
            );
      return { item, a, ok };
    });
    const failed = answers.filter((x) => !x.ok);
    const run = await tx.checklistRun.create({
      data: {
        organizationId: ctx.organizationId,
        templateId: tpl.id,
        branchId: branch.id,
        failedCount: failed.length,
        note: input.note,
        completedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await tx.checklistAnswer.createMany({
      data: answers.map(({ item, a, ok }) => ({
        organizationId: ctx.organizationId,
        runId: run.id,
        itemId: item.id,
        position: item.position,
        text: item.text,
        kind: item.kind,
        minValue: item.minValue,
        maxValue: item.maxValue,
        yes: item.kind === "YES_NO" ? a.yes === "yes" : null,
        value: item.kind === "NUMBER" ? (a.value as string) : null,
        ok,
        note: a.note,
      })),
    });
    let nonConformance: { id: string; number: string } | null = null;
    if (failed.length > 0) {
      nonConformance = await openNonConformanceInTx(tx, ctx, {
        branchId: branch.id,
        timeZone: branch.timeZone,
        title: `Checklist "${tpl.name}": ${failed.length} item(s) failed`,
        description: failed
          .map(
            (f) =>
              `- ${f.item.text}${f.a.value !== undefined ? `: ${f.a.value}` : ""}${f.a.note ? ` (${f.a.note})` : ""}`,
          )
          .join("\n"),
        severity: automaticSeverity(failed.length),
        source: "CHECKLIST",
      });
      await tx.checklistRun.update({
        where: { id: run.id },
        data: { nonConformanceId: nonConformance.id },
      });
    }
    await recordAudit(tx, actorOf(ctx), {
      action: "checklist.completed",
      entityType: "checklist_template",
      entityId: tpl.id,
      changes: { runId: run.id, branchId: branch.id, failed: failed.length },
    });
    return { id: run.id, failed: failed.length, nonConformance };
  });
}

export async function listRuns(ctx: TenantContext, templateId?: string) {
  requireAnywhere(ctx, "foodsafety.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.checklistRun.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...branchScope(ctx),
        ...(templateId ? { templateId } : {}),
      },
      include: {
        template: { select: { id: true, name: true } },
        branch: { select: { code: true } },
        nonConformance: { select: { id: true, number: true } },
      },
      orderBy: { completedAt: "desc" },
      take: 100,
    }),
  );
}

export async function getRun(ctx: TenantContext, runId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const run = await tx.checklistRun.findFirst({
      where: { organizationId: ctx.organizationId, id: runId },
      include: {
        template: { select: { id: true, name: true } },
        branch: { select: { id: true, code: true, name: true } },
        answers: { orderBy: { position: "asc" } },
        nonConformance: { select: { id: true, number: true } },
      },
    });
    if (!run || !hasPermission(ctx.grants, "foodsafety.view", { branchId: run.branchId }))
      throw notFound("Checklist run");
    const user = await tx.user.findUnique({
      where: { id: run.completedByUserId },
      select: { name: true },
    });
    return { ...run, completedBy: user?.name ?? null };
  });
}

/** Active branches where the user holds `permission`, for pickers. */
export async function branchOptions(ctx: TenantContext, permission: Permission) {
  const scope = accessibleScope(ctx.grants, permission);
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(scope.all ? {} : { id: { in: scope.branchIds } }),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  );
}
