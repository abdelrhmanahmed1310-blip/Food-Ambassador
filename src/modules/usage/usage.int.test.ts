import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as mcp } from "@/app/api/mcp/route";
import { runAgentNow, updateAgent } from "@/modules/agents/service";
import { createApiClient } from "@/modules/api/clients";
import { askAssistant } from "@/modules/assistant/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addRecipePrice, updateRecipeSettings } from "@/modules/recipes/menu";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { recordUsage, saveUsageLimits, usageStatementCsv, usageSummary } from "./service";

/** Usage metering, the organization's limits and the monthly statement (ADR-146). */

let ctx: TenantContext;
let other: TenantContext;
let units: Record<string, string>;
let tomato: string;

async function dish(code: string, kg: string) {
  const r = await createRecipe(ctx, {
    code,
    name: code,
    type: "DISH",
    yieldQuantity: "1",
    yieldUomId: units.each,
    portions: "1",
  });
  await addIngredient(ctx, r!.versionId, {
    item: `product:${tomato}`,
    quantity: kg,
    uomId: units.kg,
  });
  await activateVersion(ctx, r!.versionId);
  await addRecipePrice(ctx, r!.id, { price: "25", effectiveFrom: businessDate(ctx.timeZone) });
  return r!.id;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("usage"));
  ({ ctx: other } = await createTenant("usage-other"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  tomato = (
    await createProduct(ctx, {
      sku: "TOMATO",
      nameEn: "Tomato",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId,
    productId: tomato,
    quantity: "100",
    uomId: units.kg,
    unitCost: "20",
  });
  await updateRecipeSettings(ctx, { targetPercent: "30" });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("usage metering (ADR-146)", () => {
  it("counts per day, metric and dimension, for the organization only", async () => {
    await recordUsage(ctx.organizationId, "ai.input_tokens", 1200, "claude-opus-5-5");
    await recordUsage(ctx.organizationId, "ai.input_tokens", 300, "claude-opus-5-5");
    await recordUsage(ctx.organizationId, "ai.output_tokens", 90, "claude-opus-5-5");
    await recordUsage(ctx.organizationId, "ai.input_tokens", 0, "claude-opus-5-5"); // nothing
    const u = await usageSummary(ctx);
    expect(u.lines).toEqual(
      expect.arrayContaining([
        { metric: "ai.input_tokens", dimension: "claude-opus-5-5", quantity: 1500 },
        { metric: "ai.output_tokens", dimension: "claude-opus-5-5", quantity: 90 },
      ]),
    );
    expect(u.used.aiTokensPerMonth).toBe(1590);
    expect((await usageSummary(other)).lines).toEqual([]);
    const csv = await usageStatementCsv(ctx, u.month);
    expect(csv).toContain("organization,month,day,metric,dimension,quantity");
    expect(csv).toContain(`ai.input_tokens,claude-opus-5-5,1500`);
    // Only settings managers see usage.
    const analyst = (await addMember(ctx, "analyst", {}, "usage-analyst")).ctx;
    await expectAppError(usageSummary(analyst), "FORBIDDEN");
    await expectAppError(saveUsageLimits(analyst, {}), "FORBIDDEN");
  });

  it("stops AI use at the monthly token limit", async () => {
    await saveUsageLimits(ctx, { aiTokensPerMonth: "1000" });
    await expectAppError(askAssistant(ctx, { question: "Stock?" }), "BUSINESS_RULE_VIOLATION");
    await saveUsageLimits(ctx, { aiTokensPerMonth: "" });
    // Without a limit the assistant goes on to its own checks (here: not switched on).
    const err = await askAssistant(ctx, { question: "Stock?" }).catch((e) => e);
    expect(err.details?.rule).toBe("ASSISTANT_NOT_CONNECTED");
  });

  it("counts agent runs and actions, and keeps agents to proposals at the monthly action limit", async () => {
    await dish("A", "0.39"); // +4 %: within the agent's 5 %
    await dish("B", "0.385"); // +2.7 %
    await saveUsageLimits(ctx, { agentActionsPerMonth: "1" });
    await updateAgent(ctx, "MENU_MARGIN", {
      enabled: true,
      autonomy: "ACT",
      runHour: "6",
      settings: { maxIncreasePercent: "5", maxActionsPerRun: "3", holdHours: "0" },
    });
    await runAgentNow(ctx, "MENU_MARGIN");
    const ps = await getDb().agentProposal.findMany({
      where: { organizationId: ctx.organizationId, kind: "PRICE_CHANGE" },
    });
    expect(ps.map((p) => p.status).sort()).toEqual(["APPROVED", "OPEN"]);
    const u = await usageSummary(ctx);
    expect(u.lines).toEqual(
      expect.arrayContaining([
        { metric: "agent.runs", dimension: "MENU_MARGIN", quantity: 1 },
        { metric: "agent.actions", dimension: "MENU_MARGIN", quantity: 1 },
      ]),
    );
    expect(u.used.agentActionsPerMonth).toBe(1);
  });

  it("refuses MCP calls over the daily limit and counts each call by tool", async () => {
    const key = (await createApiClient(ctx, { name: "Agent", scopes: ["mcp:read"] })).key;
    const call = async () =>
      (
        await (
          await mcp(
            new Request("http://localhost/api/mcp", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "list_sites", arguments: {} },
              }),
            }),
          )
        ).json()
      ).result as { isError?: boolean; content: Array<{ text: string }> };
    await saveUsageLimits(ctx, { mcpCallsPerDay: "1" });
    expect((await call()).isError).toBeFalsy();
    const refused = await call();
    expect([refused.isError, refused.content[0].text]).toEqual([
      true,
      "The organization's daily limit for MCP calls is reached.",
    ]);
    const u = await usageSummary(ctx);
    expect(u.lines).toContainEqual({ metric: "mcp.calls", dimension: "list_sites", quantity: 1 });
  });
});
