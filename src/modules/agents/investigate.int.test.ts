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
import { createProduct, listUnits } from "@/modules/catalog/service";
import { businessDate } from "@/modules/inventory/rules";
import { addGoodsLine, createInvoice } from "@/modules/invoices/service";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { getReceipt, postReceipt } from "@/modules/procurement/receipts";
import { updateProcurementSettings } from "@/modules/procurement/settings";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { saveUsageLimits, usageSummary } from "@/modules/usage/service";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { investigateAgentFinding, runAgentNow, runInvestigations, updateAgent } from "./service";

/** Claude investigates a finding with read-only tools, as the person (ADR-148). */

const KEY = "sk-ant-api03-test-key-not-real-0123456789abcd";
let ctx: TenantContext;
let other: TenantContext;
let runId: string;
let dailyRunId: string;
let findingIndex: number;
let invoiceNumber: string;

type Step = Partial<BetaMessage> | Error;
const calls: MessageCreateParamsNonStreaming[] = [];
let script: Step[] = [];
const fake: AssistantClient = {
  async check() {},
  async create(params) {
    calls.push(JSON.parse(JSON.stringify(params)));
    const next = script.shift();
    if (!next) throw new Error("script ran out");
    if (next instanceof Error) throw next;
    return {
      id: `msg_${calls.length}`,
      type: "message",
      role: "assistant",
      model: params.model,
      stop_sequence: null,
      stop_reason: "end_turn",
      usage: { input_tokens: 500, output_tokens: 100 },
      content: [],
      ...next,
    } as BetaMessage;
  },
};
const use = (id: string, name: string, input: object): Step => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id, name, input }] as unknown as BetaMessage["content"],
});
const say = (value: unknown): Step => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value),
      citations: null,
    },
  ] as BetaMessage["content"],
});
const both = (en: string, ar: string) => ({ en, ar });
const ANSWER = {
  summary: both(
    "MILL billed flour at 12 against 10 ordered.",
    "فوترت MILL الدقيق بسعر 12 مقابل 10.",
  ),
  causes: [both("A price rise not agreed on the order.", "زيادة سعر غير متفق عليها.")],
  nextStep: {
    kind: "MESSAGE",
    title: both("Ask MILL for a credit note", "اطلب إشعارًا دائنًا من MILL"),
    body: both("Please issue a credit note of 100.00.", "يرجى إصدار إشعار دائن بمبلغ 100.00."),
  },
};
/** The tool results the service sent back in the latest request. */
const lastToolResults = () =>
  (calls.at(-1)!.messages.at(-1)!.content as Array<{ type: string; content: string }>)
    .filter((b) => b.type === "tool_result")
    .map((b) => b.content)
    .join("\n");

beforeAll(async () => {
  ({ ctx } = await createTenant("investigate"));
  ({ ctx: other } = await createTenant("investigate-other"));
  setTestAssistantClient(fake);
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "JED", name: "Jeddah", type: "RESTAURANT" }))
    .id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })
  ).id;
  const flour = (
    await createProduct(ctx, {
      sku: "FLOUR",
      nameEn: "Flour",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  const supplierId = (await createSupplier(ctx, { code: "MILL", name: "Mill Co" })).id;
  await applyCountryPreset(ctx, "SA");
  const codes = Object.fromEntries((await getTaxSetup(ctx)).codes.map((c) => [c.code, c.id]));
  await updateTaxSettings(ctx, {
    country: "SA",
    vatRegistered: "on",
    pricesIncludeTax: "",
    defaultSalesTaxCodeId: codes.STD,
    defaultPurchaseTaxCodeId: codes.STD,
    vatNumber: "310122393500003",
  });
  await updateProcurementSettings(ctx, {
    overReceiptTolerancePercent: "0",
    invoicePriceTolerancePercent: "2",
  });
  const { id: orderId } = await createOrder(ctx, { supplierId, warehouseId });
  await addOrderLine(ctx, orderId, {
    productId: flour,
    quantity: "50",
    unitPrice: "10",
    uomId: units.kg,
  });
  await submitOrder(ctx, orderId);
  const order = await getOrder(ctx, orderId);
  const receipt = await postReceipt(ctx, orderId, {
    lines: [{ purchaseOrderLineId: order.lines[0].id, receivedQuantity: "50", unitPrice: "10" }],
  });
  const receiptLine = (await getReceipt(ctx, receipt.id)).lines[0].id;
  const inv = await createInvoice(ctx, {
    supplierId,
    supplierInvoiceNo: "MC-3001",
    invoiceDate: businessDate(ctx.timeZone),
    printedGross: "690",
  });
  invoiceNumber = inv.number;
  await addGoodsLine(ctx, inv.id, { receiptLineId: receiptLine, quantity: "50", unitPrice: "12" });
  await updateAgent(ctx, "INVOICE_MATCHING", {
    enabled: true,
    autonomy: "SUGGEST",
    runHour: "6",
    settings: {},
  });
  const run = await runAgentNow(ctx, "INVOICE_MATCHING");
  runId = run.runId;
  const findings = (await getDb().agentRun.findUniqueOrThrow({ where: { id: runId } }))
    .findings as Array<{
    code: string;
  }>;
  findingIndex = findings.findIndex((f) => f.code === "INVOICE_EXCEPTION");
  // A daily close run too, while the assistant is still off (no explanation call).
  await updateAgent(ctx, "DAILY_CLOSE", {
    enabled: true,
    autonomy: "SUGGEST",
    runHour: "6",
    settings: {},
  });
  dailyRunId = (await runAgentNow(ctx, "DAILY_CLOSE")).runId;
  expect(findingIndex).toBeGreaterThanOrEqual(0);
});

afterAll(async () => {
  setTestAssistantClient(null);
  await getDb().$disconnect();
});

describe("Claude investigates a finding (ADR-148)", () => {
  it("needs the assistant switched on, and only people who may use it", async () => {
    await expectAppError(
      investigateAgentFinding(ctx, runId, findingIndex),
      "BUSINESS_RULE_VIOLATION",
    );
    await updateAssistantSettings(ctx, {
      apiKey: KEY,
      model: "claude-opus-5-5",
      dailyQuestionLimit: "50",
    });
    await testAssistantConnection(ctx);
    await setAssistantEnabled(ctx, true);
    // Someone who cannot see the run does not learn it exists.
    const cook = (await addMember(ctx, "kitchen", {}, "investigate-cook")).ctx;
    await expectAppError(investigateAgentFinding(cook, runId, findingIndex), "NOT_FOUND");
    // An analyst sees the daily close but may not use the assistant.
    const analyst = (await addMember(ctx, "analyst", {}, "investigate-analyst")).ctx;
    await expectAppError(investigateAgentFinding(analyst, dailyRunId, 0), "FORBIDDEN");
    await expectAppError(investigateAgentFinding(ctx, runId, 99), "NOT_FOUND");
    await expectAppError(investigateAgentFinding(other, runId, findingIndex), "NOT_FOUND");
    expect(calls).toHaveLength(0);
  });

  it("reads the invoice and the price history as the person, then answers in both languages", async () => {
    script = [
      use("t1", "invoice_detail", { invoiceNumber }),
      use("t2", "supplier_price_history", { sku: "FLOUR", supplier: "MILL" }),
      say(ANSWER),
    ];
    const r = await investigateAgentFinding(ctx, runId, findingIndex);
    expect(r.status).toBe("OK");
    expect(r.result).toEqual(ANSWER);
    expect(r.toolCalls).toEqual([
      { name: "invoice_detail", ok: true },
      { name: "supplier_price_history", ok: true },
    ]);
    // What the tools returned: the invoice line against the order, and the receipt price.
    expect(calls).toHaveLength(3);
    const invoiceResult = (calls[1].messages.at(-1)!.content as Array<{ content: string }>)[0]
      .content;
    expect(invoiceResult).toContain("PRICE_VARIANCE");
    expect(invoiceResult).toContain('"unitPrice":"12"');
    expect(lastToolResults()).toContain('"supplier":"MILL"');
    // The request: the finding as data, read-only tools, structured answer, no ids or people.
    const first = calls[0];
    expect(first.tools?.map((t) => (t as { name: string }).name)).toEqual(
      expect.arrayContaining([
        "invoice_detail",
        "supplier_price_history",
        "dish_costs",
        "stock_levels",
      ]),
    );
    expect(first.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(first.messages)).toContain("INVOICE_EXCEPTION");
    expect(JSON.stringify(first.messages)).not.toContain(ctx.userId);
    // Shown with the run, and counted.
    expect((await runInvestigations(ctx, runId)).get(findingIndex)?.result?.nextStep.kind).toBe(
      "MESSAGE",
    );
    const u = await usageSummary(ctx);
    expect(u.lines).toContainEqual({
      metric: "ai.input_tokens",
      dimension: "claude-opus-5-5",
      quantity: 1500,
    });
  });

  it("records an unreadable answer or a provider error, and stops at the monthly AI limit", async () => {
    script = [say("not json")];
    let r = await investigateAgentFinding(ctx, runId, findingIndex);
    expect([r.status, r.error]).toEqual(["FAILED", "The investigation could not be read."]);
    script = [new Error("socket hang up")];
    r = await investigateAgentFinding(ctx, runId, findingIndex);
    expect([r.status, r.error]).toEqual(["FAILED", "socket hang up"]);
    await saveUsageLimits(ctx, { aiTokensPerMonth: "100" });
    const before = calls.length;
    await expectAppError(
      investigateAgentFinding(ctx, runId, findingIndex),
      "BUSINESS_RULE_VIOLATION",
    );
    expect(calls.length).toBe(before);
  });
});
