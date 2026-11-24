import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("REST API: create a key, read products with it, revoke it (ADR-090)", async ({ browser }) => {
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("api"),
    organization: "API Foods",
  });
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("SAFFRON");
  await page.getByLabel("Name (English)").fill("Saffron");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Saffron" })).toBeVisible();

  await page.goto(`/o/${slug}/settings/api`);
  await page.getByLabel("Name").fill("Power BI");
  await page.getByLabel("Products").check();
  await page.getByRole("button", { name: "Create key" }).click();
  const shown = page.getByTestId("api-key-once").locator("input");
  await expect(shown).toHaveValue(/^fa_/);
  const key = await shown.inputValue();

  // A separate client (no session cookie) with the key.
  const api = await page.context().request;
  const res = await api.get("/api/v1/products", {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.map((p: { sku: string }) => p.sku)).toEqual(["SAFFRON"]);
  expect(
    (await api.get("/api/v1/suppliers", { headers: { authorization: `Bearer ${key}` } })).status(),
  ).toBe(403);
  expect((await api.get("/api/v1/openapi.json")).status()).toBe(200);

  await page.reload();
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("api-key-row").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("api-key-row")).toContainText("Revoked");
  expect(
    (await api.get("/api/v1/products", { headers: { authorization: `Bearer ${key}` } })).status(),
  ).toBe(401);
  await context.close();
});

test("MCP: an agent connects with a key and reads as its creator (ADR-143)", async ({
  browser,
}) => {
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("mcp"),
    organization: "MCP Foods",
  });
  await page.goto(`/o/${slug}/settings/api`);
  await expect(page.getByTestId("mcp-connect")).toContainText("/api/mcp");
  await page.getByLabel("Name").fill("Ops agent");
  await page.getByLabel(/MCP: read reports/).check();
  await page.getByRole("button", { name: "Create key" }).click();
  const shown = page.getByTestId("api-key-once").locator("input");
  await expect(shown).toHaveValue(/^fa_/);
  const key = await shown.inputValue();

  const api = page.context().request;
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const init = await api.post("/api/mcp", {
    headers,
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e", version: "1" },
      },
    },
  });
  expect(init.status()).toBe(200);
  expect((await init.json()).result.serverInfo.name).toBe("food-ambassador");
  const tools = await api.post("/api/mcp", {
    headers,
    data: { jsonrpc: "2.0", id: 2, method: "tools/list" },
  });
  const names = (await tools.json()).result.tools.map((t: { name: string }) => t.name);
  expect(names).toContain("list_sites");
  expect(names).not.toContain("decide_agent_proposal");
  const sites = await api.post("/api/mcp", {
    headers,
    data: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_sites", arguments: {} },
    },
  });
  expect((await sites.json()).result.isError).toBeFalsy();
  expect((await api.get("/api/mcp", { headers })).status()).toBe(405);
  await context.close();
});
