import "server-only";
import { z } from "zod";
import {
  decideProposal,
  getRun,
  liftProposalPause,
  listProposals,
  listRuns,
  pausedProposals,
} from "@/modules/agents/service";
import { agentPerformance } from "@/modules/agents/performance";
import { AGENT_KINDS, REJECTION_REASONS } from "@/modules/agents/rules";
import { agentTrustSteps, changeAgentTrust } from "@/modules/agents/trust";
import { agentSettingsView, updateAgentSettings } from "@/modules/agents/settings-io";
import { liftLinePauseByCodes, pausedLines } from "@/modules/agents/line-drops";
import { hasPermission } from "@/modules/access/authorize";
import { toPlain } from "@/modules/assistant/rules";
import { TOOLS as ASSISTANT_TOOLS, runTool } from "@/modules/assistant/tools";
import { featureOn } from "@/modules/features/access";
import type { TenantContext } from "@/modules/tenancy/context";

/**
 * The tools the MCP server offers (DECISIONS.md ADR-143). Each runs as the
 * key's person, with their current access, through the same service the app's
 * pages use: what they cannot see in the app, the tool cannot return.
 * - The business read tools are the AI assistant's (ADR-122): business fields
 *   only, never guest, staff or contact details.
 * - The agent tools read runs and proposals (ADR-140) and decide a proposal,
 *   which needs the `mcp:decide` scope and the person's own right to do the work.
 */

export type McpScope = "mcp:read" | "mcp:decide";

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: McpScope;
  readOnly: boolean;
  /** Module switch the tool needs (ADR-137), if any. */
  feature?: string;
  run(ctx: TenantContext, input: unknown): Promise<McpToolResult>;
}

export type McpToolResult = { ok: true; data: unknown } | { ok: false; error: string };

const AGENTS = "agents.center";
const uuid = z.uuid();
const kind = z.enum(AGENT_KINDS);

const strict = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

/** Run a service call and turn refusals into a tool error, never an internal detail. */
async function attempt(fn: () => Promise<unknown>): Promise<McpToolResult> {
  try {
    return { ok: true, data: toPlain(await fn()) };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = (error as { message?: string }).message ?? "";
    if (code === "FORBIDDEN" || code === "NOT_FOUND")
      return { ok: false, error: "Not permitted for this person, or not found." };
    if (code === "VALIDATION_FAILED") return { ok: false, error: "Invalid input." };
    if (code === "BUSINESS_RULE_VIOLATION" || code === "CONFLICT")
      return { ok: false, error: message.slice(0, 300) || "Refused by a business rule." };
    throw error;
  }
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> | null {
  const r = schema.safeParse(input ?? {});
  return r.success ? r.data : null;
}

const invalid: McpToolResult = { ok: false, error: "Invalid input." };

/** A run as an outside agent reads it: no user ids. */
const runView = (r: Awaited<ReturnType<typeof getRun>>) => ({
  id: r.id,
  agent: r.agent.kind,
  autonomy: r.agent.autonomy,
  trigger: r.trigger,
  status: r.status,
  businessDate: r.businessDate,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  summary: r.summary,
  findings: r.findings.map((f) => ({
    severity: f.severity,
    code: f.code,
    params: f.params,
    link: f.link ?? null,
  })),
  error: r.error,
  explanation: r.explanation,
  proposals: r.proposals.map((p) => ({
    id: p.id,
    kind: p.kind,
    status: p.status,
    title: p.title,
  })),
});

const agentTools: McpTool[] = [
  {
    name: "list_agent_runs",
    title: "Agent runs",
    description:
      "Recent runs of the organization's agents (replenishment, daily close, invoice matching, food safety, menu & margin) this person may see, newest first: status, day checked, counts and how many findings.",
    inputSchema: strict({
      agent: { type: "string", enum: [...AGENT_KINDS], description: "Only this agent." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many (20)." },
    }),
    scope: "mcp:read",
    readOnly: true,
    feature: AGENTS,
    async run(ctx, input) {
      const i = parse(
        z.object({ agent: kind.optional(), limit: z.number().int().min(1).max(100).optional() }),
        input,
      );
      if (!i) return invalid;
      return attempt(async () => {
        const runs = await listRuns(ctx, { limit: 200 });
        return runs
          .filter((r) => !i.agent || r.agent.kind === i.agent)
          .slice(0, i.limit ?? 20)
          .map((r) => ({
            id: r.id,
            agent: r.agent.kind,
            status: r.status,
            trigger: r.trigger,
            businessDate: r.businessDate,
            startedAt: r.startedAt,
            summary: r.summary,
            findings: Array.isArray(r.findings) ? r.findings.length : 0,
            proposals: r._count.proposals,
          }));
      });
    },
  },
  {
    name: "get_agent_run",
    title: "Agent run",
    description:
      "One agent run in full: its findings (severity, code, parameters), counts, the proposals it made, and Claude's English and Arabic explanation when written.",
    inputSchema: strict({ runId: { type: "string", description: "The run's ID." } }, ["runId"]),
    scope: "mcp:read",
    readOnly: true,
    feature: AGENTS,
    async run(ctx, input) {
      const i = parse(z.object({ runId: uuid }), input);
      if (!i) return invalid;
      return attempt(async () => runView(await getRun(ctx, i.runId)));
    },
  },
  {
    name: "list_agent_proposals",
    title: "Agent proposals",
    description:
      "Proposals from the agents that this person could carry out (suggested or draft purchase orders, credit requests, non-conformances, new dish prices), with their details. Open ones by default.",
    inputSchema: strict({
      status: {
        type: "string",
        enum: ["OPEN", "SCHEDULED", "APPROVED", "REJECTED", "SUPERSEDED"],
        description: "Which proposals (OPEN).",
      },
    }),
    scope: "mcp:read",
    readOnly: true,
    feature: AGENTS,
    async run(ctx, input) {
      const i = parse(
        z.object({
          status: z.enum(["OPEN", "SCHEDULED", "APPROVED", "REJECTED", "SUPERSEDED"]).optional(),
        }),
        input,
      );
      if (!i) return invalid;
      return attempt(async () => {
        const r = await listProposals(ctx, { status: i.status });
        return {
          status: r.status,
          proposals: r.items.map((p) => ({
            id: p.id,
            agent: p.agent.kind,
            kind: p.kind,
            status: p.status,
            title: p.title,
            detail: p.detail,
            runId: p.runId,
            createdAt: p.createdAt,
            decidedAt: p.decidedAt,
            decisionNote: p.decisionNote,
            rejectionReason: p.rejectionReason,
          })),
        };
      });
    },
  },
  {
    name: "decide_agent_proposal",
    title: "Decide an agent proposal",
    description:
      "Approve or reject one open (or agent-scheduled) agent proposal as this person, with their own permissions, exactly as from the Agents inbox. Approving carries it out: submits a draft purchase order for approval, creates suggested draft orders, accepts an invoice exception with the credit request noted, raises a non-conformance, or sets a dish's new price. Rejecting a draft purchase order cancels it. Confirm with the person before approving.",
    inputSchema: strict(
      {
        proposalId: { type: "string", description: "The proposal's ID." },
        decision: { type: "string", enum: ["APPROVE", "REJECT"], description: "The decision." },
        reason: {
          type: "string",
          enum: [...REJECTION_REASONS],
          description:
            "Required to reject: not needed, already done, wrong amount (quantity, price or value), based on wrong data, bad timing, or other (explain in the note).",
        },
        note: { type: "string", maxLength: 500, description: "Why, kept with the decision." },
      },
      ["proposalId", "decision"],
    ),
    scope: "mcp:decide",
    readOnly: false,
    feature: AGENTS,
    async run(ctx, input) {
      const i = parse(
        z.object({
          proposalId: uuid,
          decision: z.enum(["APPROVE", "REJECT"]),
          reason: z.enum(REJECTION_REASONS).optional(),
          note: z.string().trim().max(500).optional(),
        }),
        input,
      );
      if (!i) return invalid;
      return attempt(async () => {
        const r = await decideProposal(ctx, i.proposalId, {
          decision: i.decision,
          reason: i.reason,
          note: i.note || undefined,
        });
        return { decision: i.decision, ...r };
      });
    },
  },
  {
    name: "get_agent_performance",
    title: "Agent performance",
    description:
      "How each agent this person may see did, month by month (up to 12 months), counted from the records: runs and failed runs, findings by severity, proposals made, approved and rejected by people, superseded, open, carried out by the agent, stopped during a hold, follow-ups taken, median hours to a decision and AI tokens; the approval rate, the readiness hint (READY: at least 20 decisions, 90 % or more approved and none rejected this month; MIXED; TOO_FEW) and why people rejected its proposals. For settings managers, also what may be done next: RAISE to act within limits (with whether the person must confirm reading the record), LOWER back to proposing, or NONE.",
    inputSchema: strict({
      agent: { type: "string", enum: [...AGENT_KINDS], description: "Only this agent." },
      months: { type: "integer", minimum: 1, maximum: 12, description: "How many months (6)." },
    }),
    scope: "mcp:read",
    readOnly: true,
    feature: AGENTS,
    async run(ctx, input) {
      const i = parse(
        z.object({ agent: kind.optional(), months: z.number().int().min(1).max(12).optional() }),
        input,
      );
      if (!i) return invalid;
      return attempt(async () => {
        const perf = (await agentPerformance(ctx, i.months ?? 6)).filter(
          (a) => !i.agent || a.kind === i.agent,
        );
        const steps = hasPermission(ctx.grants, "org.settings.manage")
          ? await agentTrustSteps(ctx, new Map(perf.map((a) => [a.kind, a.readiness])))
          : [];
        const agents = perf.map((a) => {
          const t = steps.find((s) => s.kind === a.kind);
          return {
            agent: a.kind,
            readiness: a.readiness,
            approvalPercent: a.approvalPercent,
            totals: a.totals,
            months: a.months,
            rejectionReasons: a.rejectionReasons,
            ...(t ? { autonomy: t.autonomy, nextStep: t.step } : {}),
          };
        });
        return { agents };
      });
    },
  },
  {
    name: "change_agent_trust",
    title: "Let an agent act, or take it back",
    description:
      "As this person (a settings manager), let a switched-on agent act within the limits in its settings (RAISE), or take it back to proposing (LOWER), exactly as from the Performance page. Only replenishment, food safety and menu & margin can act. Read get_agent_performance first: when nextStep says the record must be confirmed, show the person the agent's record and set recordRead only after they confirm they have read it. Whoever raises it lends the agent their access. Confirm with the person before changing.",
    inputSchema: strict(
      {
        agent: { type: "string", enum: [...AGENT_KINDS], description: "The agent." },
        direction: { type: "string", enum: ["RAISE", "LOWER"], description: "Raise or lower." },
        recordRead: {
          type: "boolean",
          description: "The person confirmed they read the agent's record (needed unless READY).",
        },
      },
      ["agent", "direction"],
    ),
    scope: "mcp:decide",
    readOnly: false,
    feature: AGENTS,
    async run(ctx, input) {
      const i = parse(
        z.object({
          agent: kind,
          direction: z.enum(["RAISE", "LOWER"]),
          recordRead: z.boolean().optional(),
        }),
        input,
      );
      if (!i) return invalid;
      return attempt(async () => ({
        agent: i.agent,
        ...(await changeAgentTrust(ctx, i.agent, {
          direction: i.direction,
          recordRead: i.recordRead,
        })),
      }));
    },
  },
  {
    name: "get_agent_settings",
    title: "Agent settings",
    description:
      "For a settings manager: each agent's settings as on the Agents page — on or off, autonomy (and which levels it offers), run hour (0–23, the organization's time zone) and weekdays (1 = Monday … 7 = Sunday), and its own settings: the warehouses or branches it covers (by code; empty means all), thresholds, and the limits it acts within (order amounts, actions per run, price rise percent, hold hours).",
    inputSchema: strict({
      agent: { type: "string", enum: [...AGENT_KINDS], description: "Only this agent." },
    }),
    scope: "mcp:read",
    readOnly: true,
    feature: AGENTS,
    async run(ctx, input) {
      const i = parse(z.object({ agent: kind.optional() }), input);
      if (!i) return invalid;
      return attempt(async () => ({
        agents: (await agentSettingsView(ctx)).filter((a) => !i.agent || a.agent === i.agent),
      }));
    },
  },
  {
    name: "update_agent_settings",
    title: "Change an agent's settings",
    description:
      "As this person (a settings manager), change some of one agent's settings, exactly as saving the Agents page; what is not given stays as it is. Read get_agent_settings first. Settings are validated as on the page; warehouses and branches are given by code. Switching an agent on, or saving it while on, lends it this person's access. To let an agent act within limits, prefer change_agent_trust, which reads its record first. Confirm the change with the person before calling.",
    inputSchema: strict(
      {
        agent: { type: "string", enum: [...AGENT_KINDS], description: "The agent." },
        enabled: { type: "boolean", description: "Switch it on or off." },
        autonomy: {
          type: "string",
          enum: ["SUGGEST", "DRAFT", "ACT"],
          description: "How far it may go.",
        },
        runHour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "Local hour of its run.",
        },
        runDays: {
          type: "array",
          items: { type: "integer", minimum: 1, maximum: 7 },
          minItems: 1,
          maxItems: 7,
          description: "ISO weekdays it runs on.",
        },
        settings: {
          type: "object",
          description:
            "Some of the agent's own settings, by the names get_agent_settings returns (warehouses and branches as lists of codes).",
        },
      },
      ["agent"],
    ),
    scope: "mcp:decide",
    readOnly: false,
    feature: AGENTS,
    async run(ctx, input) {
      const i = parse(z.object({ agent: kind }).passthrough(), input);
      if (!i) return invalid;
      const { agent, ...patch } = i as { agent: (typeof AGENT_KINDS)[number] } & Record<
        string,
        unknown
      >;
      return attempt(async () => updateAgentSettings(ctx, agent, patch));
    },
  },
  {
    name: "list_paused_items",
    title: "What the agents stopped proposing",
    description:
      "What the agents hold back because people rejected it twice in 30 days as not needed or already done, until when, for the records this person could decide: dish prices, credit requests and non-conformances (by the latest rejected proposal), and products left out of a warehouse's order suggestions (by warehouse code and SKU).",
    inputSchema: strict({}),
    scope: "mcp:read",
    readOnly: true,
    feature: AGENTS,
    async run(ctx) {
      return attempt(async () => ({
        proposals: (await pausedProposals(ctx)).map((p) => ({
          proposalId: p.proposalId,
          agent: p.agent,
          kind: p.kind,
          title: p.title,
          pausedUntil: p.until,
        })),
        products: (await pausedLines(ctx)).map((p) => ({
          warehouse: p.warehouse,
          sku: p.sku,
          name: p.name,
          pausedUntil: p.until,
        })),
      }));
    },
  },
  {
    name: "lift_pause",
    title: "Let an agent propose something again",
    description:
      'As this person, let an agent propose again what it stopped proposing after repeated rejections: give either the proposalId from list_paused_items, or a warehouse code and SKU for a product. Exactly as "Allow proposing this again" in the Agents inbox, for whoever could decide it; audited. Confirm with the person first.',
    inputSchema: strict({
      proposalId: { type: "string", description: "A paused record's latest rejected proposal." },
      warehouse: { type: "string", description: "Warehouse code (with sku)." },
      sku: { type: "string", description: "Product SKU (with warehouse)." },
    }),
    scope: "mcp:decide",
    readOnly: false,
    feature: AGENTS,
    async run(ctx, input) {
      const i = parse(
        z.union([
          z.object({ proposalId: uuid }).strict(),
          z
            .object({
              warehouse: z.string().trim().min(1).max(60),
              sku: z.string().trim().min(1).max(60),
            })
            .strict(),
        ]),
        input,
      );
      if (!i) return invalid;
      return attempt(async () =>
        "proposalId" in i
          ? liftProposalPause(ctx, i.proposalId)
          : liftLinePauseByCodes(ctx, i.warehouse, i.sku),
      );
    },
  },
];

const businessTools: McpTool[] = ASSISTANT_TOOLS.map((t) => ({
  name: t.definition.name,
  title: t.definition.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
  description: t.definition.description ?? "",
  inputSchema: t.definition.input_schema as Record<string, unknown>,
  scope: "mcp:read" as const,
  readOnly: true,
  async run(ctx: TenantContext, input: unknown): Promise<McpToolResult> {
    const r = await runTool(ctx, t.definition.name, input);
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      data: {
        data: r.output.data,
        // Pages in the app behind the figures.
        sources: r.output.sources.map((s) => ({
          label: s.label,
          path: `/o/${ctx.organizationSlug}${s.href}`,
        })),
      },
    };
  },
}));

export const MCP_TOOLS: readonly McpTool[] = [...businessTools, ...agentTools];

/** The tools a key may call: its scopes and the organization's module switches. */
export function toolsFor(ctx: TenantContext, scopes: readonly string[]): McpTool[] {
  return MCP_TOOLS.filter(
    (t) => scopes.includes(t.scope) && (!t.feature || featureOn(ctx, t.feature)),
  );
}
