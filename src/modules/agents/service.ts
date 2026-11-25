import "server-only";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
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
import { recordUsage, usageLeft, withinLimit } from "@/modules/usage/service";
import { canRunDailyClose, runDailyClose } from "./daily-close";
import { canRunFoodSafety, runFoodSafety } from "./food-safety";
import { canRunInvoiceMatching, runInvoiceMatching } from "./invoice-matching";
import { canRunMenuMargin, runMenuMargin } from "./menu-margin";
import { explainRun, explainRunNow } from "./explain";
import { investigateFinding, investigationsOf } from "./investigate";
import { readExplanation } from "./explain-rules";
import { canRunReplenishment, runReplenishment, type NewProposal } from "./replenishment";
import {
  AGENT_AUTONOMY,
  AGENT_KINDS,
  actionsWithinLimits,
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
            // Acting within limits starts from drafts, like DRAFT (ADR-145).
            agent.autonomy === "SUGGEST" ? "SUGGEST" : "DRAFT",
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
    const saved: Array<{ id: string; kind: string; detail: Prisma.JsonValue }> = [];
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
        saved.push(
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
            select: { id: true, kind: true, detail: true },
          }),
        );
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
    await recordUsage(organizationId, "agent.runs", 1, kind, ctx.timeZone);
    // Within its limits the agent carries out its own proposals (ADR-145).
    if (agent.autonomy === "ACT" && saved.length) await scheduleActions(ctx, agent, kind, saved);
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

/** Claude investigates one finding of a run the person may see (ADR-148). */
export async function investigateAgentFinding(
  ctx: TenantContext,
  runId: string,
  findingIndex: number,
) {
  const run = await getRun(ctx, runId);
  if (run.status !== "SUCCEEDED")
    throw businessRuleViolation("AGENT_RUN_NOT_SUCCEEDED", "Only a successful run is investigated");
  return investigateFinding(ctx, run.id, findingIndex);
}

/** The latest investigation of each finding, for a run the person may see. */
export async function runInvestigations(ctx: TenantContext, runId: string) {
  await getRun(ctx, runId);
  return investigationsOf(ctx, runId);
}

/** Explain a run (again) from its page (ADR-141). */
export const explainAgentRun = (ctx: TenantContext, runId: string) =>
  explainRunNow(ctx, runId, (kind) => canSeeKind(ctx, kind));

/** Proposals the person may decide: those for warehouses they order for. */
export async function listProposals(ctx: TenantContext, raw: { status?: string } = {}) {
  if (!canSeeAgents(ctx)) throw forbidden();
  const status =
    (["OPEN", "SCHEDULED", "APPROVED", "REJECTED", "SUPERSEDED"] as const).find(
      (s) => s === raw.status,
    ) ?? "OPEN";
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
 * Rejecting the others changes nothing but the proposal. A proposal the agent
 * scheduled (ADR-145) can be decided the same way before it is carried out.
 */
export async function decideProposal(ctx: TenantContext, proposalId: string, raw: unknown) {
  const parsed = decideSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const p = await withTenantTx(ctx.organizationId, (tx) =>
    tx.agentProposal.findFirst({ where: { organizationId: ctx.organizationId, id: proposalId } }),
  );
  if (!p) throw notFound("Proposal");
  if (p.status !== "OPEN" && p.status !== "SCHEDULED")
    throw businessRuleViolation("PROPOSAL_DECIDED", "This proposal was already decided");
  const whBranch = await withTenantTx(ctx.organizationId, (tx) =>
    warehouseBranchesInTx(tx, ctx.organizationId, p.warehouseId ? [p.warehouseId] : []),
  );
  if (!mayDecide(ctx.grants, p, whBranch)) throw forbidden();
  return applyDecision(ctx, p, parsed.data.decision, parsed.data.note, { byAgent: false });
}

type ProposalRow = NonNullable<Awaited<ReturnType<Tx["agentProposal"]["findFirst"]>>>;

/** Carry out a decision through the existing services, then record it. */
async function applyDecision(
  ctx: TenantContext,
  p: ProposalRow,
  decision: "APPROVE" | "REJECT",
  note: string | undefined,
  opts: { byAgent: boolean },
) {
  const detail = p.detail as Record<string, unknown>;
  let created: string[] = [];
  let outcome: Record<string, unknown> = {};
  let agentKind = "";
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
      where: {
        organizationId: ctx.organizationId,
        id: p.id,
        status: { in: ["OPEN", "SCHEDULED"] },
      },
      data: {
        status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
        actedByAgent: opts.byAgent,
        ...(Object.keys(outcome).length ? { detail: { ...detail, ...outcome } as Json } : {}),
      },
    });
    if (done.count === 0)
      throw businessRuleViolation("PROPOSAL_DECIDED", "This proposal was already decided");
    agentKind =
      (await tx.agent.findFirst({ where: { id: p.agentId }, select: { kind: true } }))?.kind ?? "";
    await recordAudit(tx, actorOf(ctx), {
      action: opts.byAgent
        ? "agent.action_carried_out"
        : decision === "APPROVE"
          ? "agent.proposal_approved"
          : "agent.proposal_rejected",
      entityType: "agent_proposal",
      entityId: p.id,
      changes: { kind: p.kind, entityId: p.entityId, ...outcome },
    });
  });
  // Metering (ADR-146): what agents did themselves, and what people approved.
  if (opts.byAgent || decision === "APPROVE")
    await recordUsage(
      ctx.organizationId,
      opts.byAgent ? "agent.actions" : "agent.approvals",
      1,
      agentKind,
      ctx.timeZone,
    );
  return { createdOrders: created, outcome };
}

// ─── Acting within limits (ADR-145) ───

const HOUR = 3_600_000;

/** Whether the organization paused every agent action (the kill switch). */
async function actionsPaused(organizationId: string) {
  const org = await withTenantTx(organizationId, (tx) =>
    tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { agentActionsPausedAt: true },
    }),
  );
  return org.agentActionsPausedAt !== null;
}

/**
 * After a run: the new proposals within the agent's limits are scheduled to
 * be carried out after the hold, or at once with no hold. The people who
 * could decide them are told, so they can stop any of them in the inbox.
 */
async function scheduleActions(
  ctx: TenantContext,
  agent: { id: string; settings: Prisma.JsonValue },
  kind: AgentKindCode,
  saved: ReadonlyArray<{ id: string; kind: string; detail: Prisma.JsonValue }>,
) {
  const org = ctx.organizationId;
  if (await actionsPaused(org)) return;
  const settings = readSettings(kind, agent.settings) as Record<string, unknown>;
  // What this agent carried out or scheduled in the last 24 hours, for the daily limit.
  const recent = await withTenantTx(org, (tx) =>
    tx.agentProposal.findMany({
      where: {
        organizationId: org,
        agentId: agent.id,
        OR: [
          { status: "SCHEDULED" },
          { actedByAgent: true, decidedAt: { gte: new Date(Date.now() - 24 * HOUR) } },
        ],
      },
      select: { detail: true },
    }),
  );
  const actedToday = recent.reduce((a, r) => {
    const total = (r.detail as { total?: unknown }).total;
    return typeof total === "string" && /^\d+(\.\d+)?$/.test(total) ? a.plus(total) : a;
  }, new Decimal(0));
  const picked = actionsWithinLimits(
    kind,
    settings,
    saved.map((p, index) => ({ index, kind: p.kind, detail: p.detail as Record<string, unknown> })),
    { baseCurrency: ctx.baseCurrency, actedToday },
  ).map((i) => saved[i]);
  // The organization's monthly limit on agent actions (ADR-146), counting what is already scheduled.
  const left = (await usageLeft(org, "agentActionsPerMonth")).left;
  if (left !== null) {
    const scheduled = await withTenantTx(org, (tx) =>
      tx.agentProposal.count({ where: { organizationId: org, status: "SCHEDULED" } }),
    );
    picked.splice(Math.max(left - scheduled, 0));
  }
  if (picked.length === 0) return;
  const hold = Number(settings.holdHours ?? 0);
  if (hold === 0) {
    for (const p of picked) await carryOut(ctx, p.id);
  } else {
    await withTenantTx(org, async (tx) => {
      await tx.agentProposal.updateMany({
        where: { organizationId: org, id: { in: picked.map((p) => p.id) }, status: "OPEN" },
        data: { status: "SCHEDULED", scheduledFor: new Date(Date.now() + hold * HOUR) },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "agent.actions_scheduled",
        entityType: "agent",
        entityId: agent.id,
        changes: { kind, count: picked.length, holdHours: hold },
      });
    });
  }
  await withTenantTx(org, async (tx) => {
    const rows = await tx.agentProposal.findMany({
      where: { organizationId: org, id: { in: picked.map((p) => p.id) } },
      select: { kind: true, warehouseId: true, branchId: true },
    });
    const whBranch = await warehouseBranchesInTx(
      tx,
      org,
      rows.flatMap((r) => (r.warehouseId ? [r.warehouseId] : [])),
    );
    const users = (await membersWithGrantsInTx(tx, org))
      .filter((m) => rows.some((r) => mayDecide(m.grants, r, whBranch)))
      .map((m) => m.userId);
    await notifyInTx(tx, org, users, {
      kind: "AGENT_ACTIONS",
      params: { count: picked.length, hours: hold },
      link: hold ? "/agents/inbox?status=SCHEDULED" : "/agents/inbox?status=APPROVED",
      dedupeKey: `agent-actions:${picked[0].id}`,
    });
  });
}

/** Carry out one proposal as the agent's person; on failure it goes back to people. */
async function carryOut(ctx: TenantContext, proposalId: string) {
  const p = await withTenantTx(ctx.organizationId, (tx) =>
    tx.agentProposal.findFirst({ where: { organizationId: ctx.organizationId, id: proposalId } }),
  );
  if (!p || (p.status !== "OPEN" && p.status !== "SCHEDULED")) return "skipped" as const;
  const whBranch = await withTenantTx(ctx.organizationId, (tx) =>
    warehouseBranchesInTx(tx, ctx.organizationId, p.warehouseId ? [p.warehouseId] : []),
  );
  const backToPeople = (why: string) =>
    withTenantTx(ctx.organizationId, (tx) =>
      tx.agentProposal.updateMany({
        where: {
          organizationId: ctx.organizationId,
          id: p.id,
          status: { in: ["OPEN", "SCHEDULED"] },
        },
        data: {
          status: "OPEN",
          detail: { ...(p.detail as object), actionError: why.slice(0, 300) } as Json,
        },
      }),
    );
  if (!mayDecide(ctx.grants, p, whBranch)) {
    await backToPeople("The agent's person may not do this");
    return "returned" as const;
  }
  if (!(await withinLimit(ctx.organizationId, "agentActionsPerMonth"))) {
    await backToPeople("The organization's monthly limit for agent actions is reached");
    return "returned" as const;
  }
  try {
    await applyDecision(ctx, p, "APPROVE", undefined, { byAgent: true });
    return "done" as const;
  } catch (error) {
    await backToPeople(errorText(error));
    return "returned" as const;
  }
}

/**
 * For the job runner: carry out every scheduled action whose hold is over.
 * An agent switched off or no longer acting, a person without access, or a
 * paused organization sends the action back to people instead.
 */
export async function executeDueActions(now = new Date()) {
  const due = await withSystemTx((tx) =>
    tx.agentProposal.findMany({
      where: { status: "SCHEDULED", scheduledFor: { lte: now } },
      select: {
        id: true,
        organizationId: true,
        agent: { select: { enabled: true, autonomy: true, runAsUserId: true } },
        organization: {
          select: { slug: true, status: true, disabledFeatures: true, agentActionsPausedAt: true },
        },
      },
      orderBy: { scheduledFor: "asc" },
      take: 200,
    }),
  );
  const counts = { done: 0, returned: 0 };
  for (const d of due) {
    const reopen = (why: string) =>
      withSystemTx((tx) =>
        tx.agentProposal.updateMany({
          where: { id: d.id, status: "SCHEDULED" },
          data: { status: "OPEN" },
        }),
      ).then(() => {
        counts.returned += 1;
        return why;
      });
    const o = d.organization;
    if (
      o.status !== "ACTIVE" ||
      o.agentActionsPausedAt ||
      !featureOn({ disabledFeatures: o.disabledFeatures }, FEATURE) ||
      !d.agent.enabled ||
      d.agent.autonomy !== "ACT" ||
      !d.agent.runAsUserId
    ) {
      await reopen("agent not acting");
      continue;
    }
    const ctx = await withSystemTx((tx) =>
      resolveTenantContext(tx, d.agent.runAsUserId!, o.slug, `agent-act:${d.id}`),
    );
    if (!ctx) {
      await reopen("no access");
      continue;
    }
    const r = await carryOut(ctx, d.id);
    if (r === "done") counts.done += 1;
    else if (r === "returned") counts.returned += 1;
  }
  return counts;
}

/** A person stops a scheduled action: it goes back to the inbox as a proposal. */
export async function stopScheduledAction(ctx: TenantContext, proposalId: string) {
  const p = await withTenantTx(ctx.organizationId, (tx) =>
    tx.agentProposal.findFirst({ where: { organizationId: ctx.organizationId, id: proposalId } }),
  );
  if (!p) throw notFound("Proposal");
  const whBranch = await withTenantTx(ctx.organizationId, (tx) =>
    warehouseBranchesInTx(tx, ctx.organizationId, p.warehouseId ? [p.warehouseId] : []),
  );
  if (!mayDecide(ctx.grants, p, whBranch)) throw forbidden();
  await withTenantTx(ctx.organizationId, async (tx) => {
    const r = await tx.agentProposal.updateMany({
      where: { organizationId: ctx.organizationId, id: p.id, status: "SCHEDULED" },
      data: { status: "OPEN" },
    });
    if (r.count === 0)
      throw businessRuleViolation("PROPOSAL_NOT_SCHEDULED", "This action is no longer scheduled");
    await recordAudit(tx, actorOf(ctx), {
      action: "agent.action_stopped",
      entityType: "agent_proposal",
      entityId: p.id,
      changes: { kind: p.kind },
    });
  });
}

/** The kill switch: pause or resume every agent action in the organization. */
export async function setAgentActionsPaused(ctx: TenantContext, paused: boolean) {
  assertPermission(ctx.grants, "org.settings.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.organization.update({
      where: { id: ctx.organizationId },
      data: paused
        ? { agentActionsPausedAt: new Date(), agentActionsPausedByUserId: ctx.userId }
        : { agentActionsPausedAt: null, agentActionsPausedByUserId: null },
    });
    // Pausing hands everything scheduled back to people.
    const back = paused
      ? await tx.agentProposal.updateMany({
          where: { organizationId: ctx.organizationId, status: "SCHEDULED" },
          data: { status: "OPEN" },
        })
      : { count: 0 };
    await recordAudit(tx, actorOf(ctx), {
      action: paused ? "agent.actions_paused" : "agent.actions_resumed",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: { returnedToInbox: back.count },
    });
  });
}

export async function agentControls(ctx: TenantContext) {
  if (!canSeeAgents(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: { agentActionsPausedAt: true },
    });
    return { pausedAt: org.agentActionsPausedAt };
  });
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
