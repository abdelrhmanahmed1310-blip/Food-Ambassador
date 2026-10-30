import "server-only";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { canClose, isOverdue, statusAfterActionAdded } from "./rules";
import { actionSchema, investigateSchema, nonConformanceSchema, noteSchema } from "./schemas";
import { branchScope, loadBranch, openNonConformanceInTx, requireAnywhere } from "./service";

/**
 * Non-conformances and corrective actions (DECISIONS.md ADR-035):
 * OPEN → INVESTIGATING → ACTION_PLANNED → CLOSED. Actions are done by one
 * person and verified by another; a non-conformance closes only when every
 * action is verified.
 */

async function lockNc(tx: Tx, ctx: TenantContext, ncId: string) {
  await tx.$queryRaw`
    SELECT "id" FROM "non_conformances"
    WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${ncId}::uuid
    FOR UPDATE`;
  const nc = await tx.nonConformance.findFirst({
    where: { organizationId: ctx.organizationId, id: ncId },
    include: { actions: true, branch: { select: { timeZone: true } } },
  });
  if (!nc || !hasPermission(ctx.grants, "foodsafety.view", { branchId: nc.branchId }))
    throw notFound("Non-conformance");
  assertPermission(ctx.grants, "foodsafety.manage", { branchId: nc.branchId });
  if (nc.status === "CLOSED")
    throw businessRuleViolation("NC_CLOSED", "The non-conformance is closed");
  return nc;
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  nc: { id: string; number: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `non_conformance.${action}`,
    entityType: "non_conformance",
    entityId: nc.id,
    changes: { number: nc.number, ...changes },
  });
}

export async function raiseNonConformance(ctx: TenantContext, rawInput: unknown) {
  const parsed = nonConformanceSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await loadBranch(tx, ctx, parsed.data.branchId, "foodsafety.record");
    return openNonConformanceInTx(tx, ctx, {
      ...parsed.data,
      timeZone: branch.timeZone,
      source: "MANUAL",
    });
  });
}

export async function startInvestigation(ctx: TenantContext, ncId: string, rawInput: unknown) {
  const parsed = investigateSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const nc = await lockNc(tx, ctx, ncId);
    await tx.nonConformance.update({
      where: { id: nc.id },
      data: {
        rootCause: parsed.data.rootCause,
        status: nc.status === "OPEN" ? "INVESTIGATING" : nc.status,
      },
    });
    await audit(tx, ctx, nc, "root_cause", parsed.data);
  });
}

export async function addCorrectiveAction(ctx: TenantContext, ncId: string, rawInput: unknown) {
  const parsed = actionSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const nc = await lockNc(tx, ctx, ncId);
    if (input.ownerUserId) {
      const member = await tx.organizationMembership.findFirst({
        where: { organizationId: ctx.organizationId, userId: input.ownerUserId, status: "ACTIVE" },
        select: { id: true },
      });
      if (!member)
        throw businessRuleViolation("OWNER_NOT_MEMBER", "Choose an active member", {
          field: "ownerUserId",
        });
    }
    const action = await tx.correctiveAction.create({
      data: {
        organizationId: ctx.organizationId,
        nonConformanceId: nc.id,
        description: input.description,
        ownerUserId: input.ownerUserId ?? null,
        dueOn: input.dueOn ? new Date(`${input.dueOn}T00:00:00Z`) : null,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await tx.nonConformance.update({
      where: { id: nc.id },
      data: { status: statusAfterActionAdded(nc.status) },
    });
    await audit(tx, ctx, nc, "action_added", { actionId: action.id, ...input });
  });
}

async function lockAction(tx: Tx, ctx: TenantContext, ncId: string, actionId: string) {
  const nc = await lockNc(tx, ctx, ncId);
  const action = nc.actions.find((a) => a.id === actionId);
  if (!action) throw notFound("Corrective action");
  return { nc, action };
}

export async function completeAction(
  ctx: TenantContext,
  ncId: string,
  actionId: string,
  rawInput: unknown,
) {
  const parsed = noteSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { nc, action } = await lockAction(tx, ctx, ncId, actionId);
    if (action.status !== "OPEN")
      throw businessRuleViolation("ACTION_STATUS", "The action is not open");
    await tx.correctiveAction.update({
      where: { id: action.id },
      data: {
        status: "DONE",
        doneAt: new Date(),
        doneByUserId: ctx.userId,
        doneNote: parsed.data.note,
      },
    });
    await audit(tx, ctx, nc, "action_done", { actionId, note: parsed.data.note });
  });
}

/** Verification by someone other than the person who did the action. */
export async function verifyAction(
  ctx: TenantContext,
  ncId: string,
  actionId: string,
  rawInput: unknown,
) {
  const parsed = noteSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { nc, action } = await lockAction(tx, ctx, ncId, actionId);
    if (action.status !== "DONE")
      throw businessRuleViolation("ACTION_STATUS", "The action is not done yet");
    if (action.doneByUserId === ctx.userId)
      throw businessRuleViolation(
        "SELF_VERIFICATION_NOT_ALLOWED",
        "Someone else must verify this action",
      );
    await tx.correctiveAction.update({
      where: { id: action.id },
      data: {
        status: "VERIFIED",
        verifiedAt: new Date(),
        verifiedByUserId: ctx.userId,
        verifyNote: parsed.data.note,
      },
    });
    await audit(tx, ctx, nc, "action_verified", { actionId, note: parsed.data.note });
  });
}

export async function closeNonConformance(ctx: TenantContext, ncId: string, rawInput: unknown) {
  const parsed = noteSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const nc = await lockNc(tx, ctx, ncId);
    if (!canClose(nc.status, nc.actions))
      throw businessRuleViolation(
        "NC_ACTIONS_NOT_VERIFIED",
        "Every corrective action must be verified first",
      );
    await tx.nonConformance.update({
      where: { id: nc.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        closedByUserId: ctx.userId,
        closeNote: parsed.data.note,
      },
    });
    await audit(tx, ctx, nc, "closed", { note: parsed.data.note });
  });
}

export async function listNonConformances(ctx: TenantContext, options: { open?: boolean } = {}) {
  requireAnywhere(ctx, "foodsafety.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.nonConformance.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...branchScope(ctx),
        ...(options.open ? { status: { not: "CLOSED" } } : {}),
      },
      include: {
        branch: { select: { code: true, timeZone: true } },
        actions: { select: { status: true, dueOn: true } },
      },
      orderBy: { raisedAt: "desc" },
      take: 200,
    });
    return rows.map((r) => {
      const today = businessDate(r.branch.timeZone ?? ctx.timeZone);
      return {
        ...r,
        overdue: r.actions.filter((a) =>
          isOverdue(a.dueOn?.toISOString().slice(0, 10) ?? null, a.status, today),
        ).length,
        openActions: r.actions.filter((a) => a.status !== "VERIFIED").length,
      };
    });
  });
}

export async function getNonConformance(ctx: TenantContext, ncId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const nc = await tx.nonConformance.findFirst({
      where: { organizationId: ctx.organizationId, id: ncId },
      include: {
        branch: { select: { id: true, code: true, name: true, timeZone: true } },
        actions: { orderBy: { createdAt: "asc" } },
        records: { select: { id: true, type: true, valueCelsius: true, recordedAt: true } },
        runs: { select: { id: true, completedAt: true, template: { select: { name: true } } } },
      },
    });
    if (!nc || !hasPermission(ctx.grants, "foodsafety.view", { branchId: nc.branchId }))
      throw notFound("Non-conformance");
    const ids = new Set<string>([nc.raisedByUserId]);
    if (nc.closedByUserId) ids.add(nc.closedByUserId);
    for (const a of nc.actions)
      for (const id of [a.ownerUserId, a.doneByUserId, a.verifiedByUserId]) if (id) ids.add(id);
    const users = await tx.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true },
    });
    const name = (id: string | null) =>
      id ? (users.find((u) => u.id === id)?.name ?? null) : null;
    const members = await tx.organizationMembership.findMany({
      where: { organizationId: ctx.organizationId, status: "ACTIVE" },
      select: { userId: true, user: { select: { name: true } } },
      orderBy: { user: { name: "asc" } },
    });
    const today = businessDate(nc.branch.timeZone ?? ctx.timeZone);
    const manage =
      nc.status !== "CLOSED" &&
      hasPermission(ctx.grants, "foodsafety.manage", { branchId: nc.branchId });
    return {
      ...nc,
      names: { raisedBy: name(nc.raisedByUserId), closedBy: name(nc.closedByUserId) },
      actions: nc.actions.map((a) => ({
        ...a,
        owner: name(a.ownerUserId),
        doneBy: name(a.doneByUserId),
        verifiedBy: name(a.verifiedByUserId),
        overdue: isOverdue(a.dueOn?.toISOString().slice(0, 10) ?? null, a.status, today),
        canVerify: manage && a.status === "DONE" && a.doneByUserId !== ctx.userId,
      })),
      members: members.map((m) => ({ id: m.userId, name: m.user.name })),
      can: { manage, close: manage && canClose(nc.status, nc.actions) },
    };
  });
}
