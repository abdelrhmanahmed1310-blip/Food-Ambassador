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
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import { approveException } from "@/modules/invoices/service";
import { raiseNonConformance } from "@/modules/foodsafety/nonconformances";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { addRecipePrice } from "@/modules/recipes/menu";
import { canRunDailyClose, runDailyClose } from "./daily-close";
import { canRunFoodSafety, runFoodSafety } from "./food-safety";
import { canRunInvoiceMatching, runInvoiceMatching } from "./invoice-matching";
import { canRunMenuMargin, runMenuMargin } from "./menu-margin";
import { explainRun, explainRunNow } from "./explain";
import { readExplanation } from "./explain-rules";
import { canRunReplenishment, runReplenishment, type NewProposal } from "./replenishment";
import {
  AGENT_AUTONOMY,
  AGENT_KINDS,
  AUTONOMY_FOR,
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

/** Who can do each agent's work, and so lend it their access (ADR-140, ADR-142). */
const CAN_RUN: Record<AgentKindCode, (ctx: TenantContext) => boolean> = {
  REPLENISHMENT: canRunReplenishment,
  DAILY_CLOSE: canRunDailyClose,
  INVOICE_MATCHING: canRunInvoiceMatching,
  FOOD_SAFETY: canRunFoodSafety,
  MENU_MARGIN: canRunMenuMargin,
};
const canRun = (kind: AgentKindCode, ctx: TenantContext) => CAN_RUN[kind](ctx);

/** Who sees an agent's runs: settings managers, and the people its work is for. */
export function canSeeKind(ctx: TenantContext, kind: AgentKindCode) {
  if (hasPermission(ctx.grants, "org.settings.manage")) return true;
  return canRun(kind, ctx);
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
  if (!AUTONOMY_FOR[kind].includes(input.autonomy))
    throw businessRuleViolation("AGENT_AUTONOMY_NOT_OFFERED", "This agent only proposes", {
      field: "autonomy",
    });
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

/** A proposal as far as deciding it goes (ADR-140, ADR-142). */
interface ProposalScope {
  kind: string;
  warehouseId: string | null;
  branchId: string | null;
}

/**
 * Who may decide a proposal: the person who would do the work by hand —
 * ordering for the warehouse, approving invoice exceptions, recording food
 * safety at the branch, or managing recipes.
 */
function mayDecide(
  grants: TenantContext["grants"],
  p: ProposalScope,
  warehouseBranch: ReadonlyMap<string, string | null>,
) {
  switch (p.kind) {
    case "PURCHASE_ORDER":
    case "REORDER":
      return (
        p.warehouseId !== null &&
        hasPermission(grants, "purchasing.manage", {
          branchId: warehouseBranch.get(p.warehouseId) ?? undefined,
          warehouseId: p.warehouseId,
        })
      );
    case "CREDIT_REQUEST":
      return hasPermission(grants, "invoices.manage");
    case "RAISE_NC":
      return (
        p.branchId !== null && hasPermission(grants, "foodsafety.record", { branchId: p.branchId })
      );
    case "PRICE_CHANGE":
      return hasPermission(grants, "recipes.manage");
    default:
      return false;
  }
}

async function warehouseBranchesInTx(tx: Tx, organizationId: string, ids: string[]) {
  const whs = ids.length
    ? await tx.warehouse.findMany({
        where: { organizationId, id: { in: ids } },
        select: { id: true, branchId: true },
      })
    : [];
  return new Map(whs.map((w) => [w.id, w.branchId]));
}

async function notifyRunInTx(
  tx: Tx,
  organizationId: string,
  kind: AgentKindCode,
  runId: string,
  result: { findings: Finding[]; proposals: NewProposal[]; businessDate?: string },
  runAsUserId: string,
) {
  const members = await membersWithGrantsInTx(tx, organizationId);
  if (kind !== "DAILY_CLOSE") {
    if (result.proposals.length === 0) return;
    const scopes = result.proposals.map((p) => ({
      kind: p.kind,
      warehouseId: p.warehouseId ?? null,
      branchId: p.branchId ?? null,
    }));
    const whBranch = await warehouseBranchesInTx(
      tx,
      organizationId,
      scopes.flatMap((p) => (p.warehouseId ? [p.warehouseId] : [])),
    );
    const users = members
      .filter((m) => scopes.some((p) => mayDecide(m.grants, p, whBranch)))
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

/** Equal as JSON whatever the key order (the database stores JSONB keys in its own order). */
function sameJson(a: unknown, b: unknown) {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
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
    const result: {
      summary: Record<string, unknown>;
      findings: Finding[];
      proposals: NewProposal[];
      businessDate?: string;
    } =
      kind === "REPLENISHMENT"
        ? await runReplenishment(
            ctx,
            readSettings("REPLENISHMENT", agent.settings),
            agent.autonomy as "SUGGEST" | "DRAFT",
            count,
          )
        : kind === "DAILY_CLOSE"
          ? {
              ...(await runDailyClose(
                ctx,
                readSettings("DAILY_CLOSE", agent.settings),
                opts.date ?? null,
                count,
              )),
              proposals: [],
            }
          : kind === "INVOICE_MATCHING"
            ? await runInvoiceMatching(ctx, readSettings("INVOICE_MATCHING", agent.settings), count)
            : kind === "FOOD_SAFETY"
              ? await runFoodSafety(ctx, readSettings("FOOD_SAFETY", agent.settings), count)
              : await runMenuMargin(ctx, readSettings("MENU_MARGIN", agent.settings), count);
    const businessDate = result.businessDate;
    const created: NewProposal[] = [];
    await withTenantTx(organizationId, async (tx) => {
      // Suggestions replace the last run's open ones for the same warehouse (drafts count as on order).
      const suggestWarehouses = result.proposals.flatMap((p) =>
        p.kind === "REORDER" && p.warehouseId ? [p.warehouseId] : [],
      );
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
      // One open proposal per record (ADR-142): an unchanged one stays, a changed one
      // replaces it, and nothing is proposed again for 30 days after an approval.
      const since = new Date(Date.now() - 30 * 86_400_000);
      for (const p of result.proposals) {
        if (p.kind === "REORDER" || p.kind === "PURCHASE_ORDER" || !p.entityId) {
          created.push(p);
          continue;
        }
        const earlier = await tx.agentProposal.findMany({
          where: {
            organizationId,
            agentId: agent.id,
            kind: p.kind,
            entityId: p.entityId,
            branchId: p.branchId ?? null,
            OR: [{ status: "OPEN" }, { status: "APPROVED", decidedAt: { gte: since } }],
          },
          select: { id: true, status: true, detail: true },
        });
        if (earlier.some((e) => e.status === "APPROVED")) continue;
        const open = earlier.filter((e) => e.status === "OPEN");
        if (open.some((e) => sameJson(e.detail, p.detail))) continue;
        if (open.length)
          await tx.agentProposal.updateMany({
            where: { id: { in: open.map((e) => e.id) }, status: "OPEN" },
            data: { status: "SUPERSEDED" },
          });
        created.push(p);
      }
      for (const p of created)
        await tx.agentProposal.create({
          data: {
            organizationId,
            agentId: agent.id,
            runId: run.id,
            kind: p.kind,
            title: p.title.slice(0, 200),
            detail: p.detail as Json,
            warehouseId: p.warehouseId ?? null,
            branchId: p.branchId ?? null,
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
          proposals: created.length,
        },
      });
      await notifyRunInTx(
        tx,
        organizationId,
        kind,
        run.id,
        { ...result, proposals: created, businessDate },
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
  const purchasing = accessibleScope(ctx.grants, "purchasing.manage");
  const foodSafety = accessibleScope(ctx.grants, "foodsafety.record");
  return withTenantTx(ctx.organizationId, async (tx) => {
    // Each person sees the proposals they could decide (ADR-142).
    const or: Prisma.AgentProposalWhereInput[] = [];
    if (purchasing.all) or.push({ kind: { in: ["PURCHASE_ORDER", "REORDER"] } });
    else if (purchasing.branchIds.length || purchasing.warehouseIds.length) {
      const whs = await tx.warehouse.findMany({
        where: {
          organizationId: ctx.organizationId,
          OR: [{ branchId: { in: purchasing.branchIds } }, { id: { in: purchasing.warehouseIds } }],
        },
        select: { id: true },
      });
      or.push({
        kind: { in: ["PURCHASE_ORDER", "REORDER"] },
        warehouseId: { in: whs.map((w) => w.id) },
      });
    }
    if (hasPermission(ctx.grants, "invoices.manage")) or.push({ kind: "CREDIT_REQUEST" });
    if (foodSafety.all) or.push({ kind: "RAISE_NC" });
    else if (foodSafety.branchIds.length)
      or.push({ kind: "RAISE_NC", branchId: { in: foodSafety.branchIds } });
    if (hasPermission(ctx.grants, "recipes.manage")) or.push({ kind: "PRICE_CHANGE" });
    return {
      status,
      items: or.length
        ? await tx.agentProposal.findMany({
            where: { organizationId: ctx.organizationId, status, OR: or },
            orderBy: { createdAt: "desc" },
            take: 100,
            include: { agent: { select: { kind: true } } },
          })
        : [],
    };
  });
}

const decideSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(500).optional(),
});

const NC_TEXT = {
  EXPIRED_STOCK: (d: Record<string, string>) => ({
    title: `Expired stock available: ${d.sku} lot ${d.lot}`,
    description: `Lot ${d.lot} of ${d.sku} expired on ${d.expiredOn} and is still available in ${d.warehouses} (${d.quantity}). Raised from an agent proposal.`,
  }),
  CALIBRATION_OVERDUE: (d: Record<string, string>) => ({
    title: `Calibration overdue: ${d.equipment}`,
    description: `${d.equipment} (${d.equipmentName}) is in service past its calibration due date. Raised from an agent proposal.`,
  }),
} as const;

/**
 * Approve or reject a proposal, as the person deciding, with their own
 * permissions (ADR-140, ADR-142):
 * - a draft purchase order is submitted into the approval chain (rejecting cancels it);
 * - suggested order lines become draft orders for the approver to review;
 * - a credit request approves the invoice's match exception with a note of the
 *   credit asked for (not by the person who entered the invoice);
 * - a non-conformance proposal raises the non-conformance at its branch;
 * - a price change adds the dish's new price from the set day.
 * Rejecting the others changes nothing but the proposal.
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
  const whBranch = await withTenantTx(ctx.organizationId, (tx) =>
    warehouseBranchesInTx(tx, ctx.organizationId, p.warehouseId ? [p.warehouseId] : []),
  );
  if (!mayDecide(ctx.grants, p, whBranch)) throw forbidden();
  const detail = p.detail as Record<string, unknown>;
  let created: string[] = [];
  let outcome: Record<string, unknown> = {};
  if (p.kind === "PURCHASE_ORDER" && p.entityId) {
    if (decision === "APPROVE") await submitOrder(ctx, p.entityId);
    else await cancelOrder(ctx, p.entityId, { reason: note || "Rejected agent proposal" });
  } else if (decision === "APPROVE" && p.kind === "REORDER" && p.warehouseId) {
    const r = await createOrdersFromPlan(
      ctx,
      p.warehouseId,
      (detail.ruleIds as string[] | undefined) ?? [],
      (detail.basis as "MIN_MAX" | "FORECAST" | undefined) ?? "MIN_MAX",
    );
    created = r.orders.map((o) => o.id);
    outcome = { createdOrders: created };
  } else if (decision === "APPROVE" && p.kind === "CREDIT_REQUEST" && p.entityId) {
    await approveException(ctx, p.entityId, {
      note: `Credit note of ${String(detail.total)} ${String(detail.currency)} requested from ${String(detail.supplier)} for the differences (agent proposal).${note ? ` ${note}` : ""}`.slice(
        0,
        1000,
      ),
    });
  } else if (decision === "APPROVE" && p.kind === "RAISE_NC" && p.branchId) {
    const d = detail as Record<string, string>;
    const text = NC_TEXT[d.reason as keyof typeof NC_TEXT];
    if (!text)
      throw businessRuleViolation("PROPOSAL_UNKNOWN", "This proposal cannot be carried out");
    const nc = await raiseNonConformance(ctx, {
      branchId: p.branchId,
      severity: d.severity,
      ...text(d),
    });
    outcome = { nonConformanceId: nc.id, nonConformance: nc.number };
  } else if (decision === "APPROVE" && p.kind === "PRICE_CHANGE" && p.entityId) {
    const days = Number(detail.effectiveInDays ?? 1);
    const effectiveFrom = addDays(businessDate(ctx.timeZone), Number.isFinite(days) ? days : 1);
    await addRecipePrice(ctx, p.entityId, {
      price: String(detail.newPrice),
      effectiveFrom,
      note: "Back to the food cost target (agent proposal)",
      idempotencyKey: `agent-proposal:${p.id}`,
    });
    outcome = { effectiveFrom };
  }
  await withTenantTx(ctx.organizationId, async (tx) => {
    const done = await tx.agentProposal.updateMany({
      where: { organizationId: ctx.organizationId, id: p.id, status: "OPEN" },
      data: {
        status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
        ...(Object.keys(outcome).length ? { detail: { ...detail, ...outcome } as Json } : {}),
      },
    });
    if (done.count === 0)
      throw businessRuleViolation("PROPOSAL_DECIDED", "This proposal was already decided");
    await recordAudit(tx, actorOf(ctx), {
      action: decision === "APPROVE" ? "agent.proposal_approved" : "agent.proposal_rejected",
      entityType: "agent_proposal",
      entityId: p.id,
      changes: { kind: p.kind, entityId: p.entityId, ...outcome },
    });
  });
  return { createdOrders: created, outcome };
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
