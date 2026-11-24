import "server-only";
import { z } from "zod";
import { decideProposal, getRun, listProposals, listRuns } from "@/modules/agents/service";
import { AGENT_KINDS } from "@/modules/agents/rules";
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
        enum: ["OPEN", "APPROVED", "REJECTED", "SUPERSEDED"],
        description: "Which proposals (OPEN).",
      },
    }),
    scope: "mcp:read",
    readOnly: true,
    feature: AGENTS,
    async run(ctx, input) {
      const i = parse(
        z.object({ status: z.enum(["OPEN", "APPROVED", "REJECTED", "SUPERSEDED"]).optional() }),
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
          })),
        };
      });
    },
  },
  {
    name: "decide_agent_proposal",
    title: "Decide an agent proposal",
    description:
      "Approve or reject one open agent proposal as this person, with their own permissions, exactly as from the Agents inbox. Approving carries it out: submits a draft purchase order for approval, creates suggested draft orders, accepts an invoice exception with the credit request noted, raises a non-conformance, or sets a dish's new price. Rejecting a draft purchase order cancels it. Confirm with the person before approving.",
    inputSchema: strict(
      {
        proposalId: { type: "string", description: "The proposal's ID." },
        decision: { type: "string", enum: ["APPROVE", "REJECT"], description: "The decision." },
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
          note: z.string().trim().max(500).optional(),
        }),
        input,
      );
      if (!i) return invalid;
      return attempt(async () => {
        const r = await decideProposal(ctx, i.proposalId, {
          decision: i.decision,
          note: i.note || undefined,
        });
        return { decision: i.decision, ...r };
      });
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
