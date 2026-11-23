import { randomUUID } from "node:crypto";
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTestAssistantClient, type AssistantClient } from "@/modules/assistant/client";
import {
  setAssistantEnabled,
  testAssistantConnection,
  updateAssistantSettings,
} from "@/modules/assistant/service";
import { createRegister } from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { explainAgentRun, getRun, runAgent, updateAgent } from "./service";

/** Claude-written explanations of agent runs, in English and Arabic (ADR-141). */

const KEY = "sk-ant-api03-test-key-not-real-0123456789abcd";
let ctx: TenantContext;
let agentId: string;
let branchId: string;

type Reply = Partial<BetaMessage> | Error;
const calls: MessageCreateParamsNonStreaming[] = [];
let replies: Reply[] = [];
const fake: AssistantClient = {
  async check() {},
  async create(params) {
    calls.push(JSON.parse(JSON.stringify(params)));
    const next = replies.shift();
    if (!next) throw new Error("no reply scripted");
    if (next instanceof Error) throw next;
    return {
      id: `msg_${calls.length}`,
      type: "message",
      role: "assistant",
      model: params.model,
      stop_sequence: null,
      stop_reason: "end_turn",
      usage: { input_tokens: 900, output_tokens: 180 },
      content: [],
      ...next,
    } as BetaMessage;
  },
};
const json = (value: unknown): Reply => ({
  content: [
    { type: "text", text: JSON.stringify(value), citations: null },
  ] as BetaMessage["content"],
});
const EN =
  "- RUH: no sales were recorded for 2026-11-22 although a register is set up. Check the till.";
const AR = "- RUH: لم تُسجّل أي مبيعات في 2026-11-22 رغم وجود جهاز بيع. راجع الجهاز.";

const run = () =>
  runAgent(ctx.organizationId, agentId, "MANUAL", ctx.userId, { date: "2026-11-22" });

beforeAll(async () => {
  ({ ctx } = await createTenant("agent-explain"));
  setTestAssistantClient(fake);
  branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" })).id;
  const kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  // A register and no sales: the daily close reports NO_SALES.
  await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL1", name: "Till 1" });
  await updateAgent(ctx, "DAILY_CLOSE", {
    enabled: true,
    autonomy: "SUGGEST",
    runHour: "6",
    settings: {},
  });
  agentId = (
    await getDb().agent.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, kind: "DAILY_CLOSE" },
    })
  ).id;
});

afterAll(async () => {
  setTestAssistantClient(null);
  await getDb().$disconnect();
});

describe("agent run explanations (ADR-141)", () => {
  it("are not written while the assistant is off, and the run still succeeds", async () => {
    const r = await run();
    expect(r.status).toBe("SUCCEEDED");
    expect(calls).toHaveLength(0);
    const stored = await getRun(ctx, r.runId);
    expect(stored.explanation).toBeNull();
    expect(stored.explanationError).toBeNull();
    await expectAppError(explainAgentRun(ctx, r.runId), "BUSINESS_RULE_VIOLATION");
  });

  it("are written in English and Arabic from the run's own business data", async () => {
    await updateAssistantSettings(ctx, {
      apiKey: KEY,
      model: "claude-opus-5-5",
      dailyQuestionLimit: "50",
    });
    await testAssistantConnection(ctx);
    await setAssistantEnabled(ctx, true);
    replies = [json({ en: EN, ar: AR })];
    const r = await run();
    expect(r.status).toBe("SUCCEEDED");
    const stored = await getRun(ctx, r.runId);
    expect(stored.explanation).toEqual({ en: EN, ar: AR });
    expect(stored.explanationModel).toBe("claude-opus-5-5");
    expect(stored.explanationInputTokens).toBe(900);
    expect(stored.explanationOutputTokens).toBe(180);
    expect(stored.explainedAt).not.toBeNull();

    // One request: structured output, cached instructions, refusal fallback.
    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.output_config).toMatchObject({
      effort: "medium",
      format: { type: "json_schema", schema: { required: ["en", "ar"] } },
    });
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(JSON.stringify(req.system)).toContain("ephemeral");
    // Business data only: codes, figures and names of sites; no people or record ids.
    const sent = JSON.stringify(req.messages);
    expect(sent).toContain("NO_SALES");
    expect(sent).toContain("RUH");
    expect(sent).toContain("2026-11-22");
    for (const secret of [ctx.userId, ctx.organizationId, branchId, KEY])
      expect(sent).not.toContain(secret);
    expect(sent).not.toMatch(/@/);
  });

  it("record a refusal, a provider error or an unreadable reply without failing the run", async () => {
    replies = [{ stop_reason: "refusal", content: [] }];
    let r = await run();
    expect(r.status).toBe("SUCCEEDED");
    let stored = await getRun(ctx, r.runId);
    expect(stored.explanation).toBeNull();
    expect(stored.explanationError).toMatch(/declined/);

    replies = [new Error("socket hang up")];
    r = await run();
    expect(r.status).toBe("SUCCEEDED");
    stored = await getRun(ctx, r.runId);
    expect(stored.explanationError).toBe("socket hang up");

    replies = [json({ en: "Only English" })];
    r = await run();
    stored = await getRun(ctx, r.runId);
    expect(stored.explanation).toBeNull();
    expect(stored.explanationError).toMatch(/could not be read/);

    // Explain again from the page: this time it works.
    replies = [json({ en: EN, ar: AR })];
    await explainAgentRun(ctx, r.runId);
    stored = await getRun(ctx, r.runId);
    expect(stored.explanation).toEqual({ en: EN, ar: AR });
    expect(stored.explanationError).toBeNull();
  });

  it("are asked for only by people who may use the assistant, for successful runs", async () => {
    const ok = await getDb().agentRun.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, status: "SUCCEEDED" },
    });
    // An analyst sees the daily close but may not spend the assistant.
    const analyst = await addMember(ctx, "analyst");
    await expectAppError(explainAgentRun(analyst.ctx, ok.id), "FORBIDDEN");
    // A run that failed (its person has no access) is not explained.
    const failed = await runAgent(ctx.organizationId, agentId, "MANUAL", randomUUID());
    expect(failed.status).toBe("FAILED");
    const callsBefore = calls.length;
    await expectAppError(explainAgentRun(ctx, failed.runId), "BUSINESS_RULE_VIOLATION");
    expect(calls.length).toBe(callsBefore);
    // Another organization's run is not found.
    const other = (await createTenant("agent-explain-other")).ctx;
    await expectAppError(explainAgentRun(other, ok.id), "NOT_FOUND");
  });
});
