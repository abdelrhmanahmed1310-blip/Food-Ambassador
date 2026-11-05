import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { createCustomer } from "@/modules/pos/customers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { setTestAssistantClient, type AssistantClient } from "./client";
import { MAX_TOOL_ROUNDS } from "./rules";
import {
  askAssistant,
  deleteConversation,
  getAssistantSettings,
  getConversation,
  listConversations,
  purgeOldConversations,
  setAssistantEnabled,
  testAssistantConnection,
  updateAssistantSettings,
} from "./service";

/** The AI assistant with a scripted stand-in for Claude (ADR-122). */

const KEY = "sk-ant-api03-test-key-not-real-0123456789abcd";
let ctx: TenantContext;
let main: string;
let bar: string;

type Step = (params: MessageCreateParamsNonStreaming) => Partial<BetaMessage>;
const calls: MessageCreateParamsNonStreaming[] = [];
let script: Step[] = [];
let checkError: Error | null = null;
let createError: Error | null = null;

const fake: AssistantClient = {
  async check() {
    if (checkError) throw checkError;
  },
  async create(params) {
    // Keep a copy: the service keeps appending to the same arrays.
    calls.push(JSON.parse(JSON.stringify(params)));
    if (createError) throw createError;
    const step = script.shift();
    if (!step) throw new Error("script ran out");
    return {
      id: `msg_${calls.length}`,
      type: "message",
      role: "assistant",
      model: params.model,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
      ...step(params),
    } as BetaMessage;
  },
};

const toolUse = (id: string, name: string, input: object) => ({
  type: "tool_use" as const,
  id,
  name,
  input,
});
const say =
  (text: string): Step =>
  () => ({
    stop_reason: "end_turn",
    content: [{ type: "text", text, citations: null }] as BetaMessage["content"],
  });
const use =
  (...blocks: ReturnType<typeof toolUse>[]): Step =>
  () => ({
    stop_reason: "tool_use",
    content: blocks as unknown as BetaMessage["content"],
  });
/** Tool results the service sent back in the last request. */
const lastResults = () => {
  const last = calls.at(-1)!.messages.at(-1)!;
  return (last.content as Array<{ type: string; content: string; is_error?: boolean }>).filter(
    (b) => b.type === "tool_result",
  );
};

beforeAll(async () => {
  ({ ctx } = await createTenant("assistant"));
  setTestAssistantClient(fake);
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "OLY", name: "Olaya", type: "RESTAURANT" })).id;
  main = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  bar = (await createWarehouse(ctx, { branchId, code: "BAR", name: "Bar", type: "BAR" })).id;
  for (const [sku, wh, qty] of [
    ["RICE", main, "40"],
    ["MINT", bar, "3"],
  ] as const) {
    const productId = (
      await createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId: units.kg })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId: wh,
      productId,
      quantity: qty,
      uomId: units.kg,
      unitCost: "10",
    });
  }
  // A guest whose details must never reach the model.
  await createCustomer(ctx, { name: "Sara Guest", phone: "+966501119999", marketingConsent: "on" });
});

afterAll(async () => {
  setTestAssistantClient(null);
  await getDb().$disconnect();
});

describe("assistant settings (ADR-122)", () => {
  it("is off until a key is stored, tested and switched on", async () => {
    await expectAppError(askAssistant(ctx, { question: "Stock?" }), "BUSINESS_RULE_VIOLATION");
    await expectAppError(
      updateAssistantSettings(ctx, {
        apiKey: "hello",
        model: "claude-opus-5-5",
        dailyQuestionLimit: "50",
      }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      updateAssistantSettings(ctx, { model: "gpt-4", dailyQuestionLimit: "50" }),
      "VALIDATION_FAILED",
    );
    await updateAssistantSettings(ctx, {
      apiKey: KEY,
      model: "claude-opus-5-5",
      dailyQuestionLimit: "50",
    });
    // The key is sealed, shown only by its last four characters, and never audited.
    const row = await getDb().assistantSettings.findUniqueOrThrow({
      where: { organizationId: ctx.organizationId },
    });
    expect(row.apiKeySealed).not.toContain("test-key");
    expect((await getAssistantSettings(ctx)).keyHint).toBe("…abcd");
    const audits = await getDb().auditEvent.findMany({
      where: { organizationId: ctx.organizationId, action: { startsWith: "assistant." } },
    });
    expect(JSON.stringify(audits)).not.toContain("test-key");

    await expectAppError(setAssistantEnabled(ctx, true), "BUSINESS_RULE_VIOLATION");
    checkError = new Error("bad key");
    expect(await testAssistantConnection(ctx)).toEqual({ ok: false, error: "bad key" });
    await expectAppError(setAssistantEnabled(ctx, true), "BUSINESS_RULE_VIOLATION");
    checkError = null;
    expect((await testAssistantConnection(ctx)).ok).toBe(true);
    await setAssistantEnabled(ctx, true);
    expect((await getAssistantSettings(ctx)).enabled).toBe(true);
    // The database refuses a switched-on assistant that never passed a test.
    await expect(
      getDb().assistantSettings.update({
        where: { organizationId: ctx.organizationId },
        data: { testOk: false },
      }),
    ).rejects.toThrow();
  });
});

describe("asking (ADR-122)", () => {
  it("answers from the tools, run as the person, and cites the pages", async () => {
    script = [
      use(toolUse("t1", "list_sites", {}), toolUse("t2", "stock_levels", { search: "RICE" })),
      say("Main holds 40 kg of rice."),
    ];
    calls.length = 0;
    const r = await askAssistant(
      ctx,
      { question: "How much rice do we have? Call me on +966 50 111 0001" },
      { locale: "en" },
    );
    expect(r.answer).toBe("Main holds 40 kg of rice.");
    expect(r.personalDataRemoved).toBe(1);
    expect(r.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      ["list_sites", true],
      ["stock_levels", true],
    ]);
    expect(r.sources.map((s) => s.href)).toEqual(["/branches", "/inventory/stock?q=RICE"]);
    // Both results went back together, as plain JSON with exact quantities.
    const results = lastResults();
    expect(results).toHaveLength(2);
    expect(JSON.parse(results[1].content).rows[0]).toMatchObject({
      warehouse: "MAIN",
      sku: "RICE",
      usable: "40",
      unit: "kg",
    });
    // Request shape: Opus 5.5, tools, a cached system prompt, refusal fallback.
    const first = calls[0] as MessageCreateParamsNonStreaming & {
      fallbacks?: unknown;
      betas?: string[];
    };
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.fallbacks).toBe("default");
    expect(first.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(first.tools?.map((t) => (t as { name: string }).name)).toContain("branch_pnl");
    // Nothing personal and no key reaches the provider.
    const sent = JSON.stringify(calls);
    expect(sent).not.toContain("111 0001");
    expect(sent).not.toContain("+966501119999");
    expect(sent).not.toContain("Sara Guest");
    expect(sent).not.toContain(KEY);

    const c = await getConversation(ctx, r.conversationId);
    expect(c.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
    expect(c.messages[0].text).toBe("How much rice do we have? Call me on [removed]");
    expect(c.messages[1].sources).toHaveLength(2);

    // A follow-up carries the earlier question and answer as text.
    script = [say("Nothing else is low.")];
    await askAssistant(ctx, { conversationId: r.conversationId, question: "Anything else?" });
    expect(calls.at(-1)!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("sees only what the person may see", async () => {
    const keeper = await addMember(ctx, "warehouse", { scopeType: "WAREHOUSE", warehouseId: bar });
    script = [
      use(
        toolUse("t1", "stock_levels", { warehouseId: main }),
        toolUse("t2", "branch_pnl", { from: "2026-10-01", to: "2026-10-31" }),
      ),
      say("I can only see the bar."),
    ];
    const r = await askAssistant(keeper.ctx, { question: "Stock in Main and the P&L?" });
    const [stock, pnl] = lastResults();
    expect(JSON.parse(stock.content).rows).toEqual([]);
    expect(pnl).toMatchObject({
      is_error: true,
      content: "Not permitted for this person, or not found.",
    });
    expect(r.toolCalls.map((c) => c.ok)).toEqual([true, false]);
    // Conversations are private to their author.
    await expectAppError(getConversation(ctx, r.conversationId), "NOT_FOUND");
    expect((await listConversations(keeper.ctx)).conversations).toHaveLength(1);
    // Cashiers have no assistant; neither does another organization.
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(askAssistant(cashier.ctx, { question: "Hi" }), "FORBIDDEN");
    const { ctx: other } = await createTenant("assistant-other");
    await expectAppError(askAssistant(other, { question: "Hi" }), "BUSINESS_RULE_VIOLATION");
  });

  it("stops reading after the round limit and answers with what it has", async () => {
    calls.length = 0;
    script = [
      ...Array.from({ length: MAX_TOOL_ROUNDS + 1 }, (_, i) =>
        use(toolUse(`t${i}`, "needs_attention", {})),
      ),
      say("Here is what I found."),
    ];
    const r = await askAssistant(ctx, { question: "Check everything" });
    expect(r.answer).toBe("Here is what I found.");
    expect(calls).toHaveLength(MAX_TOOL_ROUNDS + 2);
    expect(calls.at(-1)!.tool_choice).toEqual({ type: "none" });
  });

  it("records refusals, provider errors and unknown tools without failing", async () => {
    script = [() => ({ stop_reason: "refusal", content: [] })];
    expect((await askAssistant(ctx, { question: "Something" })).answer).toBe(
      "The model declined to answer this question.",
    );
    script = [use(toolUse("t1", "drop_tables", {})), say("Done.")];
    await askAssistant(ctx, { question: "Clean up" });
    expect(lastResults()[0]).toMatchObject({ is_error: true, content: "Unknown tool drop_tables" });
    createError = new Error("socket hang up");
    const failed = await askAssistant(ctx, { question: "Sales?" });
    createError = null;
    expect(failed.failed).toBe(true);
    expect(failed.answer).toBe("The assistant could not answer: socket hang up");
    // Answers are a record: never edited.
    await expect(
      getDb().assistantMessage.updateMany({
        where: { conversationId: failed.conversationId },
        data: { text: "edited" },
      }),
    ).rejects.toThrow();
  });

  it("limits questions a day, and a new key needs a new test", async () => {
    await updateAssistantSettings(ctx, { model: "claude-opus-5-5", dailyQuestionLimit: "6" }); // six asked so far
    expect((await getAssistantSettings(ctx)).enabled).toBe(true); // same key and model
    await expectAppError(askAssistant(ctx, { question: "One more" }), "BUSINESS_RULE_VIOLATION");
    await updateAssistantSettings(ctx, { model: "claude-sonnet-5-5", dailyQuestionLimit: "50" });
    expect((await getAssistantSettings(ctx)).enabled).toBe(false);
  });

  it("deletes conversations on request and after 90 days", async () => {
    const mine = (await listConversations(ctx)).conversations;
    await deleteConversation(ctx, mine[0].id);
    await getDb().assistantConversation.update({
      where: { id: mine[1].id },
      data: { updatedAt: new Date(Date.now() - 91 * 86_400_000) },
    });
    expect((await purgeOldConversations()).purged).toBeGreaterThanOrEqual(1);
    const left = (await listConversations(ctx)).conversations.map((c) => c.id);
    expect(left).not.toContain(mine[0].id);
    expect(left).not.toContain(mine[1].id);
    expect(await getDb().assistantMessage.count({ where: { conversationId: mine[1].id } })).toBe(0);
  });
});
