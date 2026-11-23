import "server-only";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describeProviderError } from "@/modules/assistant/client";
import { FALLBACK_MODELS } from "@/modules/assistant/rules";
import { canUseAssistant, connectedAssistant } from "@/modules/assistant/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound } from "@/server/errors";
import {
  EXPLAIN_SYSTEM_PROMPT,
  EXPLANATION_SCHEMA,
  explanationPayload,
  parseExplanation,
} from "./explain-rules";
import type { AgentKindCode, Finding } from "./rules";

/**
 * Explanations of agent runs (DECISIONS.md ADR-141): after a successful run,
 * Claude writes what the run found and what to do next, in English and
 * Arabic, from the run's own figures. It uses the organization's assistant
 * connection (ADR-122) and only when that is switched on; a failure to
 * explain is recorded on the run and never fails it.
 */

export type ExplainOutcome =
  { explained: true } | { explained: false; reason: "NOT_CONNECTED" | "NOT_SUCCEEDED" | "FAILED" };

export async function explainRun(organizationId: string, runId: string): Promise<ExplainOutcome> {
  const loaded = await withTenantTx(organizationId, async (tx) => {
    const run = await tx.agentRun.findFirst({
      where: { organizationId, id: runId },
      select: {
        status: true,
        businessDate: true,
        summary: true,
        findings: true,
        agent: { select: { kind: true, autonomy: true } },
        proposals: {
          orderBy: { createdAt: "asc" },
          select: { kind: true, title: true, detail: true },
        },
      },
    });
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { baseCurrency: true },
    });
    return run ? { run, baseCurrency: org.baseCurrency } : null;
  });
  if (!loaded) throw notFound("Agent run");
  const { run } = loaded;
  if (run.status !== "SUCCEEDED") return { explained: false, reason: "NOT_SUCCEEDED" };
  const assistant = await connectedAssistant(organizationId);
  if (!assistant) return { explained: false, reason: "NOT_CONNECTED" };

  const payload = explanationPayload({
    kind: run.agent.kind as AgentKindCode,
    autonomy: run.agent.autonomy,
    businessDate: run.businessDate ? run.businessDate.toISOString().slice(0, 10) : null,
    baseCurrency: loaded.baseCurrency,
    summary: (run.summary ?? {}) as Record<string, unknown>,
    findings: (run.findings ?? []) as unknown as Finding[],
    proposals: run.proposals,
  });
  const params: MessageCreateParamsNonStreaming = {
    model: assistant.model,
    max_tokens: 16000,
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: EXPLANATION_SCHEMA },
    },
    system: [{ type: "text", text: EXPLAIN_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Explain this agent run.\n\n<run_data>\n${JSON.stringify(payload)}\n</run_data>`,
      },
    ],
    // A declined request is re-run on Anthropic's recommended fallback model.
    ...(FALLBACK_MODELS.has(assistant.model)
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {}),
  };

  let explanation: ReturnType<typeof parseExplanation> = null;
  let error: string | null = null;
  let model: string = assistant.model;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  try {
    const response = await assistant.client.create(params);
    model = response.model;
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
    if (response.stop_reason === "refusal") error = "The model declined to explain this run.";
    else if (response.stop_reason === "max_tokens") error = "The explanation was cut short.";
    else {
      const text = response.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("")
        .trim();
      explanation = parseExplanation(text);
      if (!explanation) error = "The explanation could not be read.";
    }
  } catch (e) {
    error = describeProviderError(e);
  }

  await withTenantTx(organizationId, (tx) =>
    tx.agentRun.update({
      where: { id: runId },
      data: explanation
        ? {
            explanation,
            explanationModel: model,
            explanationInputTokens: inputTokens,
            explanationOutputTokens: outputTokens,
            explanationError: null,
            explainedAt: new Date(),
          }
        : {
            explanationError: (error ?? "Unknown error").slice(0, 500),
            explanationInputTokens: inputTokens,
            explanationOutputTokens: outputTokens,
          },
    }),
  );
  return explanation ? { explained: true } : { explained: false, reason: "FAILED" };
}

/**
 * Explain (again) from the run page: for a run the person may see, by
 * someone who may use the assistant, when the assistant is switched on.
 */
export async function explainRunNow(
  ctx: TenantContext,
  runId: string,
  canSee: (kind: AgentKindCode) => boolean,
) {
  if (!canUseAssistant(ctx)) throw forbidden();
  const run = await withTenantTx(ctx.organizationId, (tx) =>
    tx.agentRun.findFirst({
      where: { organizationId: ctx.organizationId, id: runId },
      select: { agent: { select: { kind: true } } },
    }),
  );
  if (!run || !canSee(run.agent.kind as AgentKindCode)) throw notFound("Agent run");
  const outcome = await explainRun(ctx.organizationId, runId);
  if (!outcome.explained && outcome.reason === "NOT_CONNECTED")
    throw businessRuleViolation("ASSISTANT_NOT_CONNECTED", "The assistant is not switched on");
  if (!outcome.explained && outcome.reason === "NOT_SUCCEEDED")
    throw businessRuleViolation("AGENT_RUN_NOT_SUCCEEDED", "Only a successful run is explained");
  return outcome;
}
