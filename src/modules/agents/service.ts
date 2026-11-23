import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { accessibleScope, assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { featureOn } from "@/modules/features/access";
import { membersWithGrantsInTx, notifyInTx } from "@/modules/notifications/service";
import { cancelOrder, submitOrder } from "@/modules/procurement/orders";
import { createOrdersFromPlan } from "@/modules/procurement/reorder";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import { canRunDailyClose, runDailyClose } from "./daily-close";
import { explainRun, explainRunNow } from "./explain";
import { readExplanation } from "./explain-rules";
import { canRunReplenishment, runReplenishment } from "./replenishment";
import {
  AGENT_AUTONOMY,
  AGENT_KINDS,
  readSettings,
  settingsSchema,
  type AgentKindCode,
  type Finding,
} from "./rules";

/**
 * Agents (DECISIONS.md ADR-140, AgaaS Phase 0). An agent is a background
 * worker that uses the app's own services — the same permission checks,
 * rules and audit as a person — with the access of the person who switched
 * it on. Phase 0 stops at drafts: an agent proposes or prepares; a person
 * approves before anything takes effect. Every run is recorded (what it
 * looked at, found and proposed, how many service calls and how long), and
 * every change it makes carries the run's request id ("agent-run:<id>") in
 * the audit log.
 */

type Json = Prisma.InputJsonValue;
const FEATURE = "agents.center";

const canRun = (kind: AgentKindCode, ctx: TenantContext) =>
  kind === "REPLENISHMENT" ? canRunReplenishment(ctx) : canRunDailyClose(ctx);

/** Who sees an agent's runs: settings managers, and the people its work is for. */
export function canSeeKind(ctx: TenantContext, kind: AgentKindCode) {
  if (hasPermission(ctx.grants, "org.settings.manage")) return true;
  return kind === "REPLENISHMENT" ? canRunReplenishment(ctx) : canRunDailyClose(ctx);
}

export function canSeeAgents(ctx: TenantContext) {
  return AGENT_KINDS.some((k) => canSeeKind(ctx, k));
}

// ─── Settings ───

export async function listAgents(ctx: TenantContext) {
  assertPermission(ctx.grants, "org.settings.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    for (const kind of AGENT_KINDS)
      await tx.agent.upsert({
        where: { organizationId_kind: { organizationId: ctx.organizationId, kind } },
        create: { organizationId: ctx.organizationId, kind },
        update: {},
      });
    const agents = await tx.agent.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { kind: "asc" },
      include: {
        runs: { orderBy: { startedAt: "desc" }, take: 1 },
        _count: { select: { proposals: { where: { status: "OPEN" } } } },
      },
    });
    const runAs = await tx.user.findMany({
      where: { id: { in: agents.flatMap((a) => (a.runAsUserId ? [a.runAsUserId] : [])) } },
      select: { id: true, name: true },
    });
    return agents.map((a) => ({
      ...a,
      kind: a.kind as AgentKindCode,
      settings: readSettings(a.kind as AgentKindCode, a.settings),
      runAsName: runAs.find((u) => u.id === a.runAsUserId)?.name ?? null,
      lastRun: a.runs[0] ?? null,
      openProposals: a._count.proposals,
    }));
  });
}

const updateSchema = z.object({
  enabled: z.boolean(),
  autonomy: z.enum(AGENT_AUTONOMY, { error: "invalidOption" }),
  runHour: z.coerce.number().int().min(0).max(23, { error: "invalidHour" }),
  settings: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Switch an agent on or off and set what it may do. Saving it switched on
 * makes it run with the access of the person saving, who must be able to do
 * its work themselves (order for a warehouse; see the POS).
 */
export async function updateAgent(ctx: TenantContext, kind: AgentKindCode, raw: unknown) {
  assertPermission(ctx.grants, "org.settings.manage");
  if (!AGENT_KINDS.includes(kind)) throw notFound("Agent");
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const settings = settingsSchema(kind).safeParse(parsed.data.settings);
  if (!settings.success) throw validationFailed(settings.error);
  const input = parsed.data;
  if (input.enabled && !canRun(kind, ctx))
    throw businessRuleViolation(
      "AGENT_RUN_AS_NO_ACCESS",
      "Switch the agent on as someone who can do its work",
    );
  return withTenantTx(ctx.organizationId, async (tx) => {
    const before = await tx.agent.upsert({
      where: { organizationId_kind: { organizationId: ctx.organizationId, kind } },
      create: { organizationId: ctx.organizationId, kind },
      update: {},
    });
    const turningOn = input.enabled && !before.enabled;
    await tx.agent.update({
      where: { id: before.id },
      data: {
        enabled: input.enabled,
        autonomy: input.autonomy,
        runHour: input.runHour,
        settings: settings.data as Json,
        // Whoever saves it switched on lends it their access from then on.
        ...(input.enabled ? { runAsUserId: ctx.userId } : {}),
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "agent.updated",
      entityType: "agent",
      entityId: before.id,
      changes: {
        kind,
        enabled: input.enabled,
        autonomy: input.autonomy,
        runHour: input.runHour,
        ...(turningOn ? { runAs: ctx.userId } : {}),
      },
    });
  });
}

// ─── Running ───

async function notifyRunInTx(
  tx: Parameters<Parameters<typeof withTenantTx>[1]>[0],
  organizationId: string,
  kind: AgentKindCode,
  runId: string,
  result: { findings: Finding[]; proposals: Array<{ warehouseId: string }>; businessDate?: string },
  runAsUserId: string,
) {
  const members = await membersWithGrantsInTx(tx, organizationId);
  if (kind === "REPLENISHMENT") {
    if (result.proposals.length === 0) return;
    const warehouses = [...new Set(result.proposals.map((p) => p.warehouseId))];
    const whs = await tx.warehouse.findMany({
      where: { organizationId, id: { in: warehouses } },
      select: { id: true, branchId: true },
    });
    const users = members
      .filter((m) =>
        whs.some((w) =>
          hasPermission(m.grants, "purchasing.manage", { branchId: w.branchId, warehouseId: w.id }),
        ),
      )
      .map((m) => m.userId);
    await notifyInTx(tx, organizationId, users, {
      kind: "AGENT_PROPOSALS",
      params: { count: result.proposals.length },
      link: "/agents/inbox",
      dedupeKey: `agent-run:${runId}`,
    });
    return;
  }
  const branches = [...new Set(result.findings.flatMap((f) => (f.branchId ? [f.branchId] : [])))];
  if (result.findings.filter((f) => f.severity !== "INFO").length === 0) return;
  const users = members
    .filter((m) => branches.some((b) => hasPermission(m.grants, "pos.manage", { branchId: b })))
    .map((m) => m.userId);
  await notifyInTx(tx, organizationId, [...users, runAsUserId], {
    kind: "AGENT_DAILY_CLOSE",
    params: { count: result.findings.length, date: result.businessDate ?? "" },
    link: `/agents/runs/${runId}`,
    dedupeKey: `agent-run:${runId}`,
  });
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Run an agent once. It acts as `runAsUserId` with that person's current
 * access (gone access: the run fails and says so), and records the run.
 */
export async function runAgent(
  organizationId: string,
  agentId: string,
  trigger: "SCHEDULE" | "MANUAL",
  runAsUserId: string,
  opts: { startedByUserId?: string; date?: string } = {},
) {
  const started = Date.now();
  const { agent, run, slug } = await withTenantTx(organizationId, async (tx) => {
    const agent = await tx.agent.findFirstOrThrow({ where: { organizationId, id: agentId } });
    const run = await tx.agentRun.create({
      data: { organizationId, agentId, trigger, startedByUserId: opts.startedByUserId ?? null },
      select: { id: true },
    });
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { slug: true },
    });
    return { agent, run, slug: org.slug };
  });
  const kind = agent.kind as AgentKindCode;
  let calls = 0;
  const count = () => {
    calls += 1;
  };
  const finish = (data: Prisma.AgentRunUpdateInput) =>
    withTenantTx(organizationId, async (tx) => {
      await tx.agentRun.update({
        where: { id: run.id },
        data: {
          ...data,
          finishedAt: new Date(),
          durationMs: Date.now() - started,
          toolCalls: calls,
        },
      });
      await tx.agent.update({ where: { id: agent.id }, data: { lastRunAt: new Date() } });
    });
  try {
    // The person's access now, with the run's id on everything it changes.
    const ctx = await withSystemTx((tx) =>
      resolveTenantContext(tx, runAsUserId, slug, `agent-run:${run.id}`),
    );
    if (!ctx)
      throw businessRuleViolation("AGENT_RUN_AS_NO_ACCESS", "The agent's person has no access");
    if (!featureOn(ctx, FEATURE))
      throw businessRuleViolation(
        "FEATURE_DISABLED",
        "Agents are switched off for the organization",
      );
    if (!canRun(kind, ctx))
      throw businessRuleViolation(
        "AGENT_RUN_AS_NO_ACCESS",
        "The agent's person cannot do its work",
      );
    const result =
      kind === "REPLENISHMENT"
        ? await runReplenishment(
            ctx,
            readSettings("REPLENISHMENT", agent.settings),
            agent.autonomy as "SUGGEST" | "DRAFT",
            count,
          )
        : {
            ...(await runDailyClose(
              ctx,
              readSettings("DAILY_CLOSE", agent.settings),
              opts.date ?? null,
              count,
            )),
            proposals: [],
          };
    const businessDate = "businessDate" in result ? result.businessDate : undefined;
    await withTenantTx(organizationId, async (tx) => {
      // Suggestions replace the last run's open ones for the same warehouse (drafts count as on order).
      const suggestWarehouses = result.proposals
        .filter((p) => p.kind === "REORDER")
        .map((p) => p.warehouseId);
      if (suggestWarehouses.length)
        await tx.agentProposal.updateMany({
          where: {
            organizationId,
            agentId: agent.id,
            status: "OPEN",
            kind: "REORDER",
            warehouseId: { in: suggestWarehouses },
          },
          data: { status: "SUPERSEDED" },
        });
      for (const p of result.proposals)
        await tx.agentProposal.create({
          data: {
            organizationId,
            agentId: agent.id,
            runId: run.id,
            kind: p.kind,
            title: p.title.slice(0, 200),
            detail: p.detail as Json,
            warehouseId: p.warehouseId,
            entityType: p.entityType ?? null,
            entityId: p.entityId ?? null,
          },
        });
      await tx.agentRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          durationMs: Date.now() - started,
          toolCalls: calls,
          summary: result.summary as Json,
          findings: result.findings as unknown as Json,
          businessDate: businessDate ? new Date(businessDate) : null,
        },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "agent.ran",
        entityType: "agent",
        entityId: agent.id,
        changes: {
          kind,
          trigger,
          run: run.id,
          findings: result.findings.length,
          proposals: result.proposals.length,
        },
      });
      await notifyRunInTx(
        tx,
        organizationId,
        kind,
        run.id,
        { ...result, businessDate },
        runAsUserId,
      );
    });
    await withTenantTx(organizationId, (tx) =>
      tx.agent.update({ where: { id: agent.id }, data: { lastRunAt: new Date() } }),
    );
    // Written by Claude when the assistant is on (ADR-141); never fails the run.
    await explainRun(organizationId, run.id).catch(() => undefined);
    return { runId: run.id, status: "SUCCEEDED" as const };
  } catch (error) {
    await finish({ status: "FAILED", error: errorText(error) });
    return { runId: run.id, status: "FAILED" as const, error: errorText(error) };
  }
}

/** Run now from Settings: as the agent's person when on, else as the one asking. */
export async function runAgentNow(ctx: TenantContext, kind: AgentKindCode) {
  assertPermission(ctx.grants, "org.settings.manage");
  if (!featureOn(ctx, FEATURE)) throw forbidden("Agents are switched off");
  const agent = await withTenantTx(ctx.organizationId, (tx) =>
    tx.agent.upsert({
      where: { organizationId_kind: { organizationId: ctx.organizationId, kind } },
      create: { organizationId: ctx.organizationId, kind },
      update: {},
    }),
  );
  return runAgent(
    ctx.organizationId,
    agent.id,
    "MANUAL",
    agent.enabled && agent.runAsUserId ? agent.runAsUserId : ctx.userId,
    { startedByUserId: ctx.userId },
  );
}

/** For the job runner: each organization's switched-on agents that are due today. */
export async function dueAgents(
  now: Date,
  localDateHour: (at: Date, tz: string) => { date: string; hour: number },
) {
  return withSystemTx(async (tx) => {
    const agents = await tx.agent.findMany({
      where: { enabled: true, runAsUserId: { not: null }, organization: { status: "ACTIVE" } },
      select: {
        id: true,
        organizationId: true,
        runHour: true,
        runAsUserId: true,
        organization: { select: { timeZone: true, disabledFeatures: true } },
      },
    });
    return agents.flatMap((a) => {
      const local = localDateHour(now, a.organization.timeZone);
      if (local.hour < a.runHour) return [];
      if (!featureOn({ disabledFeatures: a.organization.disabledFeatures }, FEATURE)) return [];
      return [
        {
          agentId: a.id,
          organizationId: a.organizationId,
          runAsUserId: a.runAsUserId!,
          date: local.date,
        },
      ];
    });
  });
}

// ─── Reading ───

export async function listRuns(ctx: TenantContext, opts: { limit?: number } = {}) {
  if (!canSeeAgents(ctx)) throw forbidden();
  const kinds = AGENT_KINDS.filter((k) => canSeeKind(ctx, k));
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.agentRun.findMany({
      where: { organizationId: ctx.organizationId, agent: { kind: { in: [...kinds] } } },
      orderBy: { startedAt: "desc" },
      take: Math.min(opts.limit ?? 50, 200),
      include: {
        agent: { select: { kind: true, autonomy: true } },
        _count: { select: { proposals: true } },
      },
    }),
  );
}

export async function getRun(ctx: TenantContext, runId: string) {
  const run = await withTenantTx(ctx.organizationId, (tx) =>
    tx.agentRun.findFirst({
      where: { organizationId: ctx.organizationId, id: runId },
      include: {
        agent: { select: { kind: true, autonomy: true } },
        proposals: { orderBy: { createdAt: "asc" } },
      },
    }),
  );
  if (!run || !canSeeKind(ctx, run.agent.kind as AgentKindCode)) throw notFound("Agent run");
  return {
    ...run,
    findings: run.findings as unknown as Finding[],
    explanation: readExplanation(run.explanation),
  };
}

/** Explain a run (again) from its page (ADR-141). */
export const explainAgentRun = (ctx: TenantContext, runId: string) =>
  explainRunNow(ctx, runId, (kind) => canSeeKind(ctx, kind));

/** Proposals the person may decide: those for warehouses they order for. */
export async function listProposals(ctx: TenantContext, raw: { status?: string } = {}) {
  if (!canSeeAgents(ctx)) throw forbidden();
  const status =
    (["OPEN", "APPROVED", "REJECTED", "SUPERSEDED"] as const).find((s) => s === raw.status) ??
    "OPEN";
  const scope = accessibleScope(ctx.grants, "purchasing.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const whs = scope.all
      ? null
      : await tx.warehouse.findMany({
          where: {
            organizationId: ctx.organizationId,
            OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }],
          },
          select: { id: true },
        });
    return {
      status,
      items: await tx.agentProposal.findMany({
        where: {
          organizationId: ctx.organizationId,
          status,
          ...(whs ? { warehouseId: { in: whs.map((w) => w.id) } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { agent: { select: { kind: true } } },
      }),
    };
  });
}

const decideSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(500).optional(),
});

/**
 * Approve or reject a proposal. Approving a draft purchase order submits it
 * into the normal approval chain; approving suggested lines creates the
 * draft orders for the approver to review. Rejecting cancels the draft.
 * The person's own permissions apply throughout.
 */
export async function decideProposal(ctx: TenantContext, proposalId: string, raw: unknown) {
  const parsed = decideSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { decision, note } = parsed.data;
  const p = await withTenantTx(ctx.organizationId, (tx) =>
    tx.agentProposal.findFirst({ where: { organizationId: ctx.organizationId, id: proposalId } }),
  );
  if (!p) throw notFound("Proposal");
  if (p.status !== "OPEN")
    throw businessRuleViolation("PROPOSAL_DECIDED", "This proposal was already decided");
  assertPermission(ctx.grants, "purchasing.manage");
  const detail = p.detail as { ruleIds?: string[]; basis?: "MIN_MAX" | "FORECAST" };
  let created: string[] = [];
  if (p.kind === "PURCHASE_ORDER" && p.entityId) {
    if (decision === "APPROVE") await submitOrder(ctx, p.entityId);
    else await cancelOrder(ctx, p.entityId, { reason: note || "Rejected agent proposal" });
  } else if (p.kind === "REORDER" && decision === "APPROVE" && p.warehouseId) {
    const r = await createOrdersFromPlan(
      ctx,
      p.warehouseId,
      detail.ruleIds ?? [],
      detail.basis ?? "MIN_MAX",
    );
    created = r.orders.map((o) => o.id);
  }
  await withTenantTx(ctx.organizationId, async (tx) => {
    const done = await tx.agentProposal.updateMany({
      where: { organizationId: ctx.organizationId, id: p.id, status: "OPEN" },
      data: {
        status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
        ...(created.length
          ? { detail: { ...(p.detail as object), createdOrders: created } as Json }
          : {}),
      },
    });
    if (done.count === 0)
      throw businessRuleViolation("PROPOSAL_DECIDED", "This proposal was already decided");
    await recordAudit(tx, actorOf(ctx), {
      action: decision === "APPROVE" ? "agent.proposal_approved" : "agent.proposal_rejected",
      entityType: "agent_proposal",
      entityId: p.id,
      changes: { kind: p.kind, entityId: p.entityId, createdOrders: created },
    });
  });
  return { createdOrders: created };
}

/** Choices for the agent settings: warehouses with reorder rules, and branches. */
export async function agentFormOptions(ctx: TenantContext) {
  assertPermission(ctx.grants, "org.settings.manage");
  return withTenantTx(ctx.organizationId, async (tx) => ({
    warehouses: await tx.warehouse.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null, reorderRules: { some: {} } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    branches: await tx.branch.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  }));
}
