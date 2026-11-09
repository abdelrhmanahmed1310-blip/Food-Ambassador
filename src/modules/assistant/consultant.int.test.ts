import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { declareAllergens } from "@/modules/nutrition/service";
import { addIngredient, activateVersion, createRecipe } from "@/modules/recipes/recipes";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { setTestAssistantClient, type AssistantClient } from "./client";
import {
  askAssistant,
  getConversation,
  listConversations,
  setAssistantEnabled,
  testAssistantConnection,
  updateAssistantSettings,
} from "./service";

/** The food consultant with a scripted stand-in for Claude (ADR-131). */

const KEY = "sk-ant-api03-test-key-not-real-0123456789abcd";
let ctx: TenantContext;
let dishId: string;

type Step = (params: MessageCreateParamsNonStreaming) => Partial<BetaMessage>;
const calls: MessageCreateParamsNonStreaming[] = [];
let script: Step[] = [];

const fake: AssistantClient = {
  async check() {},
  async create(params) {
    calls.push(JSON.parse(JSON.stringify(params)));
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
const say =
  (text: string): Step =>
  () => ({
    stop_reason: "end_turn",
    content: [{ type: "text", text, citations: null }] as BetaMessage["content"],
  });
const use =
  (...blocks: Array<{ id: string; name: string; input: object }>): Step =>
  () => ({
    stop_reason: "tool_use",
    content: blocks.map((b) => ({ type: "tool_use", ...b })) as unknown as BetaMessage["content"],
  });
const lastResults = () =>
  (
    calls.at(-1)!.messages.at(-1)!.content as Array<{
      type: string;
      content: string;
      is_error?: boolean;
    }>
  ).filter((b) => b.type === "tool_result");
const systemText = (i: number) => (calls[i].system as Array<{ text: string }>)[0].text;
const toolNames = (i: number) => (calls[i].tools ?? []).map((t) => (t as { name: string }).name);

beforeAll(async () => {
  ({ ctx } = await createTenant("consultant", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  setTestAssistantClient(fake);
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const flour = (
    await createProduct(ctx, {
      sku: "FLOUR",
      nameEn: "Flour",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  await declareAllergens(ctx, flour, {
    source: "SUPPLIER_SPEC",
    reference: "Mill spec 2026-01",
    statements: { GLUTEN: "CONTAINS", SESAME: "MAY_CONTAIN" },
  });
  const dish = await createRecipe(ctx, {
    code: "FLATBREAD",
    name: "Flatbread",
    nameAr: "خبز",
    type: "DISH",
    yieldQuantity: "10",
    yieldUomId: units.each,
    portions: "10",
  });
  await addIngredient(ctx, dish!.versionId, {
    item: `product:${flour}`,
    quantity: "1",
    uomId: units.kg,
  });
  await activateVersion(ctx, dish!.versionId);
  dishId = dish!.id;
  await updateAssistantSettings(ctx, {
    apiKey: KEY,
    model: "claude-opus-5-5",
    dailyQuestionLimit: "50",
  });
  await testAssistantConnection(ctx);
  await setAssistantEnabled(ctx, true);
}, 120_000);

afterAll(async () => {
  setTestAssistantClient(null);
  await getDb().$disconnect();
});

describe("food consultant (ADR-131)", () => {
  it("answers as a consultant, with its own tools, in the interface language", async () => {
    calls.length = 0;
    script = [say("Cool cooked rice to below 5 °C within 2 hours, then refrigerate.")];
    const r = await askAssistant(
      ctx,
      { question: "How should we cool cooked rice?", mode: "CONSULTANT" },
      { locale: "ar" },
    );
    expect([r.mode, r.failed]).toEqual(["CONSULTANT", false]);
    expect(systemText(0)).toContain("food consultant for staff of");
    expect(systemText(0)).toContain("Modern Standard Arabic");
    expect(toolNames(0)).toEqual([
      "find_recipes",
      "dish_costs",
      "recipe_nutrition_allergens",
      "allergen_matrix",
    ]);
    // Consultant conversations are listed apart from business ones.
    expect((await listConversations(ctx, "CONSULTANT")).conversations.map((c) => c.id)).toEqual([
      r.conversationId,
    ]);
    expect((await listConversations(ctx, "BUSINESS")).conversations).toEqual([]);
    // A follow-up stays a consultant conversation whatever mode is sent.
    script = [say("Yes — reheat to 75 °C.")];
    await askAssistant(ctx, {
      conversationId: r.conversationId,
      question: "And reheating?",
      mode: "BUSINESS",
    });
    expect(systemText(1)).toContain("food consultant");
  });

  it("reads the recipe's recorded allergens instead of guessing", async () => {
    calls.length = 0;
    script = [
      use({ id: "t1", name: "find_recipes", input: { query: "flat" } }),
      use({ id: "t2", name: "recipe_nutrition_allergens", input: { recipeId: dishId } }),
      use({ id: "t3", name: "allergen_matrix", input: { allergen: "SESAME" } }),
      say("Flatbread contains gluten; sesame may be present; milk is not established."),
    ];
    const r = await askAssistant(ctx, {
      question: "Is our flatbread safe for a gluten allergy?",
      mode: "CONSULTANT",
    });
    expect(r.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      ["find_recipes", true],
      ["recipe_nutrition_allergens", true],
      ["allergen_matrix", true],
    ]);
    // Each request carries the results of the previous tool.
    const found = JSON.parse(
      (calls[1].messages.at(-1)!.content as Array<{ content: string }>)[0].content,
    );
    expect(found.recipes[0]).toMatchObject({
      id: dishId,
      code: "FLATBREAD",
      hasActiveVersion: true,
    });
    const facts = JSON.parse(
      (calls[2].messages.at(-1)!.content as Array<{ content: string }>)[0].content,
    );
    expect(facts.allergens.GLUTEN).toMatchObject({ status: "CONTAINS", containsVia: ["FLOUR"] });
    expect(facts.allergens.SESAME.status).toBe("MAY_CONTAIN");
    // Not declared: unknown, never "free from".
    expect(facts.allergens.MILK.status).toBe("UNKNOWN");
    const matrix = JSON.parse(lastResults()[0].content);
    expect(matrix.recipes[0].allergens).toEqual({ SESAME: "MAY_CONTAIN" });
    expect(r.sources.map((s) => s.href)).toContain(`/recipes/${dishId}/nutrition`);
    const stored = await getConversation(ctx, r.conversationId);
    expect(stored.mode).toBe("CONSULTANT");
  });

  it("is open to kitchen staff, who get general advice but not recipe data they may not see", async () => {
    const kitchen = (await addMember(ctx, "kitchen", {}, "consult-kitchen")).ctx;
    calls.length = 0;
    script = [
      use({ id: "k1", name: "find_recipes", input: {} }),
      say("I cannot see the recipes from your account; here is general guidance."),
    ];
    const r = await askAssistant(kitchen, { question: "Dough proofing tips?", mode: "CONSULTANT" });
    expect(r.toolCalls).toEqual([{ name: "find_recipes", input: {}, ok: false }]);
    expect(lastResults()[0]).toMatchObject({
      is_error: true,
      content: "Not permitted for this person, or not found.",
    });
    // Kitchen staff do not have the business assistant.
    await expectAppError(askAssistant(kitchen, { question: "Sales?" }), "FORBIDDEN");
    await expectAppError(listConversations(kitchen, "BUSINESS"), "FORBIDDEN");
    // A cashier has neither.
    const cashier = (await addMember(ctx, "cashier", {}, "consult-cashier")).ctx;
    await expectAppError(
      askAssistant(cashier, { question: "Tips?", mode: "CONSULTANT" }),
      "FORBIDDEN",
    );
    // Nobody reads another person's conversation, even in the same mode.
    await expectAppError(getConversation(ctx, r.conversationId), "NOT_FOUND");
  });

  it("audits that the consultant was asked, never the question", async () => {
    const audits = await getDb().auditEvent.findMany({
      where: { organizationId: ctx.organizationId, action: "assistant.asked" },
    });
    expect(audits.some((a) => (a.changes as { mode?: string }).mode === "CONSULTANT")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("gluten allergy");
  });
});
