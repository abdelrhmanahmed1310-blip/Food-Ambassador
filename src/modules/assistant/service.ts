import "server-only";
import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { assertPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { forbidden } from "@/server/errors";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { decryptSecret, encryptSecret, integrationKey } from "@/modules/integrations/crypto";
import { businessDate } from "@/modules/inventory/rules";
import { optionalUuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { assistantClient, describeProviderError } from "./client";
import {
  ASSISTANT_MODELS,
  FALLBACK_MODELS,
  HISTORY_TURNS,
  keyHint,
  looksLikeApiKey,
  MAX_TOOL_ROUNDS,
  QUESTION_MAX_LENGTH,
  RETENTION_DAYS,
  scrubPersonalData,
  systemPrompt,
  titleFrom,
  uniqueSources,
  type AssistantModel,
  type Source,
} from "./rules";
import { runTool, TOOL_DEFINITIONS } from "./tools";

/**
 * The AI assistant (DECISIONS.md ADR-122): questions in plain language,
 * answered by Claude from the app's own reports through read-only tools that
 * run as the person asking. It is off until an administrator stores an
 * Anthropic API key, the connection test passes and they switch it on.
 */

const key = () => {
  const env = getEnv();
  return integrationKey(env.INTEGRATION_ENCRYPTION_KEY, env.AUTH_SECRET);
};

async function loadSettings(tx: Tx, ctx: TenantContext) {
  return tx.assistantSettings.findUnique({ where: { organizationId: ctx.organizationId } });
}

function settingsView(row: Awaited<ReturnType<typeof loadSettings>>) {
  return {
    hasKey: Boolean(row?.apiKeySealed),
    keyHint: row?.apiKeyHint ?? null,
    model: (row?.model ?? "claude-opus-5-5") as AssistantModel,
    enabled: row?.enabled ?? false,
    dailyQuestionLimit: row?.dailyQuestionLimit ?? 50,
    testedAt: row?.testedAt ?? null,
    testOk: row?.testOk ?? null,
    testError: row?.testError ?? null,
  };
}

// ─── Settings (assistant.manage) ───

export async function getAssistantSettings(ctx: TenantContext) {
  assertPermission(ctx.grants, "assistant.manage");
  return withTenantTx(ctx.organizationId, async (tx) => settingsView(await loadSettings(tx, ctx)));
}

const settingsSchema = z.object({
  /** Blank keeps the stored key. */
  apiKey: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .refine((v) => v === undefined || looksLikeApiKey(v), { error: "invalidApiKey" }),
  model: z.enum(ASSISTANT_MODELS, { error: "invalidOption" }),
  dailyQuestionLimit: z
    .string()
    .transform((v) => v.trim())
    .refine((v) => /^\d{1,4}$/.test(v) && Number(v) >= 1 && Number(v) <= 1000, {
      error: "invalidQuestionLimit",
    })
    .transform(Number),
});

/**
 * Store the key, model and limit. A new key or model needs a new connection
 * test, so the assistant is switched off until it passes.
 */
export async function updateAssistantSettings(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "assistant.manage");
  const parsed = settingsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const before = await loadSettings(tx, ctx);
    if (!input.apiKey && !before?.apiKeySealed)
      throw businessRuleViolation("ASSISTANT_KEY_REQUIRED", "Enter the API key", {
        field: "apiKey",
      });
    const retest = Boolean(input.apiKey) || input.model !== (before?.model ?? "claude-opus-5-5");
    const data = {
      model: input.model,
      dailyQuestionLimit: input.dailyQuestionLimit,
      updatedByUserId: ctx.userId,
      ...(input.apiKey
        ? { apiKeySealed: encryptSecret(input.apiKey, key()), apiKeyHint: keyHint(input.apiKey) }
        : {}),
      ...(retest ? { enabled: false, testOk: null, testError: null, testedAt: null } : {}),
    };
    await tx.assistantSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ...data },
      update: data,
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "assistant.settings_updated",
      entityType: "organization",
      entityId: ctx.organizationId,
      // Never the key itself.
      changes: {
        keyReplaced: Boolean(input.apiKey),
        model: input.model,
        dailyQuestionLimit: input.dailyQuestionLimit,
      },
    });
  });
}

/** Call the provider with the stored key and model, and record the result. */
export async function testAssistantConnection(ctx: TenantContext) {
  assertPermission(ctx.grants, "assistant.manage");
  const row = await withTenantTx(ctx.organizationId, (tx) => loadSettings(tx, ctx));
  if (!row?.apiKeySealed)
    throw businessRuleViolation("ASSISTANT_KEY_REQUIRED", "Enter the API key first");
  let error: string | null = null;
  try {
    await assistantClient(decryptSecret(row.apiKeySealed, key())).check(row.model);
  } catch (e) {
    error = describeProviderError(e);
  }
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.assistantSettings.update({
      where: { organizationId: ctx.organizationId },
      data: {
        testedAt: new Date(),
        testOk: error === null,
        testError: error,
        ...(error ? { enabled: false } : {}),
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "assistant.connection_tested",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: { ok: error === null, model: row.model },
    });
  });
  return { ok: error === null, error };
}

export async function setAssistantEnabled(ctx: TenantContext, enabled: boolean) {
  assertPermission(ctx.grants, "assistant.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const row = await loadSettings(tx, ctx);
    if (enabled && !(row?.apiKeySealed && row.testOk))
      throw businessRuleViolation(
        "ASSISTANT_NOT_TESTED",
        "Test the connection before switching the assistant on",
      );
    if (!row) return;
    await tx.assistantSettings.update({
      where: { organizationId: ctx.organizationId },
      data: { enabled, updatedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: enabled ? "assistant.enabled" : "assistant.disabled",
      entityType: "organization",
      entityId: ctx.organizationId,
    });
  });
}

// ─── Asking (assistant.use) ───

/**
 * Anyone holding `assistant.use` at any site may ask; each tool still checks
 * the person's own scope for what it reads.
 */
export const canUseAssistant = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "assistant.use");
function assertCanUse(ctx: TenantContext) {
  if (!canUseAssistant(ctx)) throw forbidden();
}

const askSchema = z.object({
  conversationId: optionalUuidSchema,
  question: z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v.length >= 1, { error: "required" })
    .refine((v) => v.length <= QUESTION_MAX_LENGTH, { error: "tooLong" }),
});

interface ToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
}

/**
 * Ask a question. The conversation's earlier questions and answers (text
 * only) go with it; Claude reads what it needs through the tools, as this
 * person, and the answer is stored with the tools called and the pages
 * behind it.
 */
export async function askAssistant(
  ctx: TenantContext,
  rawInput: unknown,
  options: { locale?: "en" | "ar" } = {},
) {
  assertCanUse(ctx);
  const parsed = askSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { text: question, removed } = scrubPersonalData(parsed.data.question);
  const today = businessDate(ctx.timeZone);

  // 1. Settings, the daily limit, the conversation and the question.
  const start = await withTenantTx(ctx.organizationId, async (tx) => {
    const settings = await loadSettings(tx, ctx);
    if (!settings?.enabled || !settings.apiKeySealed || !settings.testOk)
      throw businessRuleViolation("ASSISTANT_NOT_CONNECTED", "The assistant is not switched on");
    const since = new Date(Date.now() - 86_400_000);
    const asked = await tx.assistantMessage.count({
      where: {
        organizationId: ctx.organizationId,
        role: "USER",
        createdAt: { gte: since },
        conversation: { userId: ctx.userId },
      },
    });
    if (asked >= settings.dailyQuestionLimit)
      throw businessRuleViolation("ASSISTANT_DAILY_LIMIT", "Daily question limit reached", {
        limit: settings.dailyQuestionLimit,
      });
    let conversation;
    if (parsed.data.conversationId) {
      conversation = await tx.assistantConversation.findFirst({
        where: {
          organizationId: ctx.organizationId,
          id: parsed.data.conversationId,
          userId: ctx.userId,
        },
      });
      if (!conversation) throw notFound("Conversation");
    } else {
      conversation = await tx.assistantConversation.create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          title: titleFrom(question),
        },
      });
    }
    const history = await tx.assistantMessage.findMany({
      where: { organizationId: ctx.organizationId, conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: HISTORY_TURNS * 2,
      select: { role: true, text: true },
    });
    await tx.assistantMessage.create({
      data: {
        organizationId: ctx.organizationId,
        conversationId: conversation.id,
        role: "USER",
        text: question,
      },
    });
    return {
      settings,
      conversation,
      history: history.reverse(),
    };
  });

  // 2. The tool loop, outside any transaction (each tool opens its own).
  const client = assistantClient(decryptSecret(start.settings.apiKeySealed!, key()));
  const model = start.settings.model;
  const messages: BetaMessageParam[] = [];
  for (const h of start.history) {
    const role = h.role === "USER" ? "user" : "assistant";
    // Keep strict alternation: merge a run of the same role.
    const last = messages.at(-1);
    if (last && last.role === role) last.content = `${last.content as string}\n\n${h.text}`;
    else messages.push({ role, content: h.text });
  }
  if (messages[0]?.role === "assistant") messages.shift();
  if (messages.at(-1)?.role === "user") messages.pop();
  messages.push({ role: "user", content: question });

  const params = (): MessageCreateParamsNonStreaming => ({
    model,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    system: [
      {
        type: "text",
        text: systemPrompt({
          organizationName: ctx.organizationName,
          today,
          timeZone: ctx.timeZone,
          baseCurrency: ctx.baseCurrency,
          locale: options.locale ?? "en",
        }),
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: TOOL_DEFINITIONS,
    tool_choice: { type: "auto" },
    messages,
    // A declined request is re-run on Anthropic's recommended fallback model.
    ...(FALLBACK_MODELS.has(model)
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {}),
  });

  const toolCalls: ToolCallRecord[] = [];
  const sources: Source[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let answer = "";
  let stopReason: string | null = null;
  let servedBy = model;
  let providerError: string | null = null;

  try {
    for (let round = 0; ; round++) {
      const response = await client.create(params());
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      stopReason = response.stop_reason;
      servedBy = response.model;
      if (response.stop_reason === "refusal") {
        answer = "";
        break;
      }
      const uses = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      const text = textOf(response.content);
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      if (response.stop_reason !== "tool_use" || uses.length === 0) {
        answer = text;
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      if (round >= MAX_TOOL_ROUNDS) {
        // Enough reading: ask for the answer from what it has.
        messages.push({
          role: "user",
          content: [
            ...uses.map((u): BetaToolResultBlockParam => ({
              type: "tool_result",
              tool_use_id: u.id,
              content: "Not run: the reading limit for this question was reached.",
              is_error: true,
            })),
            {
              type: "text",
              text: "Answer now from what you have, and say what you could not check.",
            },
          ],
        });
        const last = await client.create({ ...params(), tool_choice: { type: "none" } });
        inputTokens += last.usage.input_tokens;
        outputTokens += last.usage.output_tokens;
        stopReason = last.stop_reason;
        answer = textOf(last.content);
        break;
      }
      // All results of one turn go back in one message, recorded in call order.
      const ran = await Promise.all(uses.map((u) => runTool(ctx, u.name, u.input)));
      const results = uses.map((u, k): BetaToolResultBlockParam => {
        const r = ran[k];
        toolCalls.push({ name: u.name, input: u.input, ok: r.ok });
        if (!r.ok)
          return { type: "tool_result", tool_use_id: u.id, content: r.error, is_error: true };
        sources.push(...r.output.sources);
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(r.output.data) };
      });
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    providerError = describeProviderError(error);
  }

  // 3. Store the answer (or what went wrong) and the record of what was read.
  const text =
    providerError !== null
      ? `The assistant could not answer: ${providerError}`
      : stopReason === "refusal"
        ? "The model declined to answer this question."
        : answer || "No answer was given.";
  const stored = await withTenantTx(ctx.organizationId, async (tx) => {
    const message = await tx.assistantMessage.create({
      data: {
        organizationId: ctx.organizationId,
        conversationId: start.conversation.id,
        role: "ASSISTANT",
        text: text.slice(0, 20000),
        toolCalls: toolCalls as object[],
        sources: uniqueSources(sources) as object[],
        model: servedBy,
        stopReason: providerError ? "provider_error" : stopReason,
        inputTokens,
        outputTokens,
      },
      select: { id: true },
    });
    await tx.assistantConversation.update({
      where: { id: start.conversation.id },
      data: { updatedAt: new Date() },
    });
    // The audit says what was read, never the question or the answer.
    await recordAudit(tx, actorOf(ctx), {
      action: "assistant.asked",
      entityType: "assistant_conversation",
      entityId: start.conversation.id,
      changes: {
        tools: toolCalls.map((c) => c.name),
        model: servedBy,
        personalDataRemoved: removed,
        ok: providerError === null && stopReason !== "refusal",
      },
    });
    return message;
  });
  return {
    conversationId: start.conversation.id,
    messageId: stored.id,
    answer: text,
    sources: uniqueSources(sources),
    toolCalls,
    failed: providerError !== null,
    personalDataRemoved: removed,
  };
}

function textOf(content: BetaContentBlock[]): string {
  return content
    .filter((b): b is Extract<BetaContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

// ─── Reading conversations (their author only) ───

export async function listConversations(ctx: TenantContext) {
  assertCanUse(ctx);
  return withTenantTx(ctx.organizationId, async (tx) => ({
    enabled: Boolean((await loadSettings(tx, ctx))?.enabled),
    conversations: await tx.assistantConversation.findMany({
      where: { organizationId: ctx.organizationId, userId: ctx.userId },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: { id: true, title: true, updatedAt: true },
    }),
  }));
}

export async function getConversation(ctx: TenantContext, conversationId: string) {
  assertCanUse(ctx);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.assistantConversation.findFirst({
      where: { organizationId: ctx.organizationId, id: conversationId, userId: ctx.userId },
      select: {
        id: true,
        title: true,
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            role: true,
            text: true,
            toolCalls: true,
            sources: true,
            createdAt: true,
          },
        },
      },
    });
    if (!c) throw notFound("Conversation");
    return {
      ...c,
      messages: c.messages.map((m) => ({
        ...m,
        toolCalls: m.toolCalls as unknown as ToolCallRecord[],
        sources: m.sources as unknown as Source[],
      })),
    };
  });
}

export async function deleteConversation(ctx: TenantContext, conversationId: string) {
  assertCanUse(ctx);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const r = await tx.assistantConversation.deleteMany({
      where: { organizationId: ctx.organizationId, id: conversationId, userId: ctx.userId },
    });
    if (r.count === 0) throw notFound("Conversation");
  });
}

/** Conversations untouched for RETENTION_DAYS are deleted (daily job). */
export async function purgeOldConversations(options: { now?: Date } = {}) {
  const cutoff = new Date((options.now ?? new Date()).getTime() - RETENTION_DAYS * 86_400_000);
  return withSystemTx(async (tx) => {
    const r = await tx.assistantConversation.deleteMany({ where: { updatedAt: { lt: cutoff } } });
    return { purged: r.count };
  });
}
