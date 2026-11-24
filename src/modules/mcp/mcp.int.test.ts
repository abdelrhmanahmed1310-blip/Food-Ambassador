import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DELETE, GET, POST } from "@/app/api/mcp/route";
import { runAgentNow, updateAgent } from "@/modules/agents/service";
import { createApiClient, revokeApiClient } from "@/modules/api/clients";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addRecipePrice, listRecipePrices, updateRecipeSettings } from "@/modules/recipes/menu";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";

/** The MCP server for customers' own agents (ADR-143). */

let ctx: TenantContext;
let other: TenantContext;
let readKey: string;
let decideKey: string;
let salad: string;

type Rpc = { status: number; body: Record<string, unknown> | null };

async function rpc(
  key: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Rpc> {
  const res = await POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const call = async (key: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(key, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return r.body as {
    result?: {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    error?: { code: number; message: string };
  };
};

beforeAll(async () => {
  ({ ctx } = await createTenant("mcp"));
  ({ ctx: other } = await createTenant("mcp-other"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })
  ).id;
  const tomato = (
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
    quantity: "10",
    uomId: units.kg,
    unitCost: "20",
  });
  const r = await createRecipe(ctx, {
    code: "SALAD",
    name: "Salad",
    type: "DISH",
    yieldQuantity: "1",
    yieldUomId: units.each,
    portions: "1",
  });
  await addIngredient(ctx, r!.versionId, {
    item: `product:${tomato}`,
    quantity: "0.5",
    uomId: units.kg,
  });
  await activateVersion(ctx, r!.versionId);
  salad = r!.id;
  await addRecipePrice(ctx, salad, { price: "25", effectiveFrom: businessDate(ctx.timeZone) });
  await updateRecipeSettings(ctx, { targetPercent: "30" });
  readKey = (await createApiClient(ctx, { name: "Agent (read)", scopes: ["mcp:read"] })).key;
  decideKey = (
    await createApiClient(ctx, { name: "Agent (decide)", scopes: ["mcp:read", "mcp:decide"] })
  ).key;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("MCP server (ADR-143)", () => {
  it("initializes, lists the tools a key may call and answers notifications with 202", async () => {
    const init = await rpc(readKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18" } });
    const note = await rpc(readKey, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect([note.status, note.body]).toEqual([202, null]);

    const names = async (key: string) =>
      (
        (
          await rpc(
            key,
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
            { "mcp-protocol-version": "2025-06-18" },
          )
        ).body as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((t) => t.name);
    const read = await names(readKey);
    expect(read).toEqual(
      expect.arrayContaining([
        "list_sites",
        "stock_levels",
        "list_agent_runs",
        "list_agent_proposals",
      ]),
    );
    expect(read).not.toContain("decide_agent_proposal");
    expect(await names(decideKey)).toContain("decide_agent_proposal");
  });

  it("reads as the key's person, through the app's own reports", async () => {
    const sites = await call(readKey, "list_sites");
    expect(JSON.stringify(sites.result?.structuredContent)).toContain("RUH");
    // A tool the key may not call does not exist for it.
    const refused = await call(readKey, "decide_agent_proposal", {
      proposalId: "00000000-0000-7000-8000-000000000000",
      decision: "APPROVE",
    });
    expect(refused.error?.code).toBe(-32602);
    const bad = await call(readKey, "get_agent_run", { runId: "nope" });
    expect([bad.result?.isError, bad.result?.content[0].text]).toEqual([true, "Invalid input."]);
  });

  it("decides an agent proposal as the key's person, audited with the key", async () => {
    await updateAgent(ctx, "MENU_MARGIN", {
      enabled: true,
      autonomy: "SUGGEST",
      runHour: "6",
      settings: { effectiveInDays: "1" },
    });
    const run = await runAgentNow(ctx, "MENU_MARGIN");
    const runView = await call(readKey, "get_agent_run", { runId: run.runId });
    expect(runView.result?.structuredContent).toMatchObject({
      agent: "MENU_MARGIN",
      status: "SUCCEEDED",
      findings: [expect.objectContaining({ code: "ABOVE_TARGET" })],
    });
    expect(JSON.stringify(runView.result?.structuredContent)).not.toContain(ctx.userId);
    const list = await call(readKey, "list_agent_proposals");
    const proposals = (
      list.result?.structuredContent as { proposals: Array<{ id: string; kind: string }> }
    ).proposals;
    expect(proposals.map((p) => p.kind)).toEqual(["PRICE_CHANGE"]);

    // Another organization's key cannot reach it.
    const otherKey = (
      await createApiClient(other, { name: "x", scopes: ["mcp:read", "mcp:decide"] })
    ).key;
    const foreign = await call(otherKey, "decide_agent_proposal", {
      proposalId: proposals[0].id,
      decision: "APPROVE",
    });
    expect(foreign.result?.isError).toBe(true);

    const decided = await call(decideKey, "decide_agent_proposal", {
      proposalId: proposals[0].id,
      decision: "APPROVE",
      note: "Approved from our ops agent",
    });
    expect(decided.result?.structuredContent).toMatchObject({ decision: "APPROVE" });
    expect((await listRecipePrices(ctx, salad))[0].price.toString()).toBe("33.34");
    const audit = await getDb().auditEvent.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, action: "agent.proposal_approved" },
    });
    expect([audit.actorUserId, audit.requestId?.startsWith("mcp:")]).toEqual([ctx.userId, true]);
    // Decided once only.
    const again = await call(decideKey, "decide_agent_proposal", {
      proposalId: proposals[0].id,
      decision: "REJECT",
    });
    expect(again.result?.isError).toBe(true);
  });

  it("refuses missing, wrong-scope, revoked and company keys, and keys whose person left", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await rpc(null, ping)).status).toBe(401);
    const rest = (await createApiClient(ctx, { name: "REST", scopes: ["products:read"] })).key;
    expect((await rpc(rest, ping)).status).toBe(403);
    await expectAppError(
      createApiClient(ctx, {
        name: "x",
        scopes: ["mcp:read"],
        companyId: (
          await getDb().company.findFirstOrThrow({ where: { organizationId: ctx.organizationId } })
        ).id,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    const admin = await addMember(ctx, "admin", {}, "mcp-admin");
    const created = await createApiClient(admin.ctx, { name: "Admin's", scopes: ["mcp:read"] });
    expect((await rpc(created.key, ping)).status).toBe(200);
    await getDb().organizationMembership.update({
      where: { id: admin.membership.id },
      data: { status: "REMOVED" },
    });
    expect((await rpc(created.key, ping)).status).toBe(403);
    await revokeApiClient(
      ctx,
      (
        await getDb().apiClient.findFirstOrThrow({
          where: { organizationId: ctx.organizationId, name: "Agent (read)" },
        })
      ).id,
    );
    expect((await rpc(readKey, ping)).status).toBe(401);
  });

  it("keeps to the transport rules", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await rpc(decideKey, ping, { origin: "https://evil.example" })).status).toBe(403);
    expect((await rpc(decideKey, ping, { "mcp-protocol-version": "1999-01-01" })).status).toBe(400);
    const parse = await rpc(decideKey, "{not json");
    expect([parse.status, (parse.body as { error: { code: number } }).error.code]).toEqual([
      400, -32700,
    ]);
    expect(GET().status).toBe(405);
    expect(DELETE().status).toBe(405);
  });
});
