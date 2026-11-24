import { createHash } from "node:crypto";
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

test("MCP sign-in: an app registers, the person allows it, and can disconnect it (ADR-144)", async ({
  browser,
}) => {
  const { context, page } = await newClient(browser);
  await signUp(page, { name: "Owner", email: uniqueEmail("oauth"), organization: "OAuth Foods" });
  const api = page.context().request;
  const redirect = "https://agent.example/callback";
  const reg = await api.post("/oauth/register", {
    data: { client_name: "Ops agent", redirect_uris: [redirect] },
  });
  expect(reg.status()).toBe(201);
  const clientId = (await reg.json()).client_id as string;
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    state: "s1",
    scope: "mcp:read",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  // The app's own address is not reachable from the test: answer it here.
  await page.route("https://agent.example/**", (r) => r.fulfill({ body: "back in the app" }));
  await page.goto(`/oauth/authorize?${query}`);
  await expect(page.getByTestId("oauth-consent")).toContainText("Ops agent");
  await expect(page.getByText("agent.example")).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(/agent\.example\/callback\?/);
  const back = new URL(page.url());
  expect(back.searchParams.get("state")).toBe("s1");
  const code = back.searchParams.get("code")!;

  const tok = await api.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirect,
    },
  });
  expect(tok.status()).toBe(200);
  const access = (await tok.json()).access_token as string;
  const ping = await api.post("/api/mcp", {
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "ping" },
  });
  expect(ping.status()).toBe(200);

  await page.goto("/account/security");
  const row = page.getByTestId("my-connected-app");
  await expect(row).toContainText("Ops agent");
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("my-connected-app")).toHaveCount(0);
  const after = await api.post("/api/mcp", {
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 2, method: "ping" },
  });
  expect(after.status()).toBe(401);
  await context.close();
});
