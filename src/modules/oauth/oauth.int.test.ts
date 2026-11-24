import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as resourceMetadata } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as serverMetadata } from "@/app/.well-known/oauth-authorization-server/route";
import { POST as mcp } from "@/app/api/mcp/route";
import { POST as register } from "@/app/oauth/register/route";
import { POST as revoke } from "@/app/oauth/revoke/route";
import { POST as token } from "@/app/oauth/token/route";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  approveAuthorization,
  checkAuthorizeRequest,
  consentOrganizations,
  denyAuthorization,
  listConnectedApps,
  listMyConnectedApps,
  revokeConnectedApp,
} from "./service";

/** OAuth 2.1 sign-in for MCP apps (ADR-144). */

let ctx: TenantContext;
const base = getEnv().APP_URL.replace(/\/+$/, "");
const REDIRECT = "https://agent.example/callback";

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
// Each request from its own address: registrations are limited per address.
const post = (url: string, body: string, type: string) =>
  new Request(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": type, [CLIENT_IP_HEADER]: `test-${randomUUID()}` },
    body,
  });
const form = (fields: Record<string, string>) =>
  post("/oauth/token", new URLSearchParams(fields).toString(), "application/x-www-form-urlencoded");

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function registerApp(name = "Ops agent") {
  const r = await json(
    await register(
      post(
        "/oauth/register",
        JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }),
        "application/json",
      ),
    ),
  );
  expect(r.status).toBe(201);
  return r.body.client_id as string;
}

/** Consent as the tenant owner; returns the code and the verifier. */
async function authorize(
  clientId: string,
  scope = "mcp:read mcp:decide",
  choice = scope.split(" "),
) {
  const { verifier, challenge } = pkce();
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "xyz",
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${base}/api/mcp`,
  };
  const url = new URL(
    await approveAuthorization(ctx.userId, params, {
      organizationId: ctx.organizationId,
      scopes: choice,
    }),
  );
  expect([
    url.origin + url.pathname,
    url.searchParams.get("state"),
    url.searchParams.get("iss"),
  ]).toEqual([REDIRECT, "xyz", base]);
  return { code: url.searchParams.get("code")!, verifier };
}

const mcpCall = (bearer: string, body: unknown) =>
  mcp(
    new Request(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  ({ ctx } = await createTenant("oauth"));
  await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("OAuth for MCP (ADR-144)", () => {
  it("publishes where to sign in, and the MCP server points there on 401", async () => {
    const rm = await json(resourceMetadata());
    expect(rm.body).toMatchObject({ resource: `${base}/api/mcp`, authorization_servers: [base] });
    const as = await json(serverMetadata());
    expect(as.body).toMatchObject({
      issuer: base,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    const res = await mcpCall("fao_not-a-real-token-at-all-xxxxx", {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"`,
    );
  });

  it("registers public clients with safe redirect addresses only", async () => {
    const bad = await json(
      await register(
        post(
          "/oauth/register",
          JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
          "application/json",
        ),
      ),
    );
    expect([bad.status, bad.body.error]).toEqual([400, "invalid_redirect_uri"]);
    const secret = await json(
      await register(
        post(
          "/oauth/register",
          JSON.stringify({
            redirect_uris: [REDIRECT],
            token_endpoint_auth_method: "client_secret_basic",
          }),
          "application/json",
        ),
      ),
    );
    expect(secret.body.error).toBe("invalid_client_metadata");
    const id = await registerApp();
    expect(id).toMatch(/^fac_/);
    // 20 registrations an hour from one address.
    const ip = `test-${randomUUID()}`;
    const fromOne = () =>
      register(
        new Request(`${base}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json", [CLIENT_IP_HEADER]: ip },
          body: JSON.stringify({ redirect_uris: [REDIRECT] }),
        }),
      );
    for (let i = 0; i < 20; i++) expect((await fromOne()).status).toBe(201);
    expect((await fromOne()).status).toBe(429);
  });

  it("refuses requests it cannot trust, and sends others back with the error", async () => {
    const clientId = await registerApp();
    expect(await checkAuthorizeRequest({ client_id: "fac_nope" })).toEqual({
      ok: false,
      show: "UNKNOWN_CLIENT",
    });
    expect(
      await checkAuthorizeRequest({ client_id: clientId, redirect_uri: "https://evil.example/cb" }),
    ).toEqual({ ok: false, show: "BAD_REDIRECT" });
    const noPkce = await checkAuthorizeRequest({ client_id: clientId, response_type: "code" });
    expect("redirect" in noPkce && noPkce.redirect).toContain("error=invalid_request");
    const { challenge } = pkce();
    const wrongResource = await checkAuthorizeRequest({
      client_id: clientId,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://other.example/mcp",
    });
    expect("redirect" in wrongResource && wrongResource.redirect).toContain("error=invalid_target");
    const denied = await denyAuthorization({
      client_id: clientId,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
    });
    expect(denied).toContain("error=access_denied");
    expect(denied).toContain("state=s1");
    // Someone who is not a member cannot consent for the organization.
    const outsider = await createTenant("oauth-outsider");
    expect((await consentOrganizations(outsider.ctx.userId)).map((o) => o.id)).not.toContain(
      ctx.organizationId,
    );
    await expectAppError(
      approveAuthorization(
        outsider.ctx.userId,
        {
          client_id: clientId,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        { organizationId: ctx.organizationId, scopes: ["mcp:read"] },
      ),
      "FORBIDDEN",
    );
  });

  it("exchanges a code once with PKCE, and the token works at the MCP server as the person", async () => {
    const clientId = await registerApp();
    const { code, verifier } = await authorize(clientId, "mcp:read mcp:decide", ["mcp:read"]);
    const wrong = await json(
      await token(
        form({
          grant_type: "authorization_code",
          code,
          code_verifier: pkce().verifier,
          client_id: clientId,
          redirect_uri: REDIRECT,
        }),
      ),
    );
    expect(wrong.body.error).toBe("invalid_grant");
    // The failed attempt used the code up: it cannot be retried.
    const again = await json(
      await token(
        form({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: REDIRECT,
        }),
      ),
    );
    expect(again.body.error).toBe("invalid_grant");

    const fresh = await authorize(clientId, "mcp:read mcp:decide", ["mcp:read"]);
    const t = await json(
      await token(
        form({
          grant_type: "authorization_code",
          code: fresh.code,
          code_verifier: fresh.verifier,
          client_id: clientId,
          redirect_uri: REDIRECT,
          resource: `${base}/api/mcp`,
        }),
      ),
    );
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:read" });
    const tools = await json(
      await mcpCall(t.body.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    const names = tools.body.result.tools.map((x: { name: string }) => x.name);
    expect(names).toContain("list_sites");
    expect(names).not.toContain("decide_agent_proposal"); // only mcp:read was allowed
    const sites = await json(
      await mcpCall(t.body.access_token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_sites", arguments: {} },
      }),
    );
    expect(JSON.stringify(sites.body.result.structuredContent)).toContain("RUH");
    // Only hashes are stored.
    const stored = await getDb().oAuthToken.findMany({
      where: { organizationId: ctx.organizationId },
    });
    expect(JSON.stringify(stored)).not.toContain(t.body.access_token);
  });

  it("rotates refresh tokens and revokes the grant when an old one comes back", async () => {
    const clientId = await registerApp();
    const { code, verifier } = await authorize(clientId);
    const first = (
      await json(
        await token(
          form({
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            client_id: clientId,
          }),
        ),
      )
    ).body;
    const second = await json(
      await token(
        form({
          grant_type: "refresh_token",
          refresh_token: first.refresh_token,
          client_id: clientId,
        }),
      ),
    );
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    // Another client cannot use it.
    const other = await registerApp("Other");
    const stolen = await json(
      await token(
        form({
          grant_type: "refresh_token",
          refresh_token: second.body.refresh_token,
          client_id: other,
        }),
      ),
    );
    expect(stolen.body.error).toBe("invalid_grant");
    // The replaced token comes back: everything for the grant is revoked.
    const replay = await json(
      await token(
        form({
          grant_type: "refresh_token",
          refresh_token: first.refresh_token,
          client_id: clientId,
        }),
      ),
    );
    expect(replay.body.error).toBe("invalid_grant");
    expect(
      (await mcpCall(second.body.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status,
    ).toBe(401);
    const newer = await json(
      await token(
        form({
          grant_type: "refresh_token",
          refresh_token: second.body.refresh_token,
          client_id: clientId,
        }),
      ),
    );
    expect(newer.body.error).toBe("invalid_grant");
  });

  it("is revoked by the app, by the person or by an administrator, and stops with the person's access", async () => {
    const clientId = await registerApp("Revocable");
    const tokensFor = async () => {
      const { code, verifier } = await authorize(clientId);
      return (
        await json(
          await token(
            form({
              grant_type: "authorization_code",
              code,
              code_verifier: verifier,
              client_id: clientId,
            }),
          ),
        )
      ).body as { access_token: string; refresh_token: string };
    };
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

    // The app revokes its refresh token: the grant ends.
    const a = await tokensFor();
    const r = await revoke(
      post("/oauth/revoke", `token=${a.refresh_token}`, "application/x-www-form-urlencoded"),
    );
    expect(r.status).toBe(200);
    expect((await mcpCall(a.access_token, ping)).status).toBe(401);

    // The person disconnects it from their account.
    const b = await tokensFor();
    const mine = await listMyConnectedApps(ctx.userId);
    expect(mine.map((g) => g.client.clientName)).toContain("Revocable");
    const live = (await listConnectedApps(ctx)).filter((g) => g.client.clientName === "Revocable");
    expect(live).toHaveLength(1);
    await revokeConnectedApp(ctx, live[0].id);
    expect((await mcpCall(b.access_token, ping)).status).toBe(401);
    const audit = await getDb().auditEvent.count({
      where: { organizationId: ctx.organizationId, action: "oauth_grant.revoked" },
    });
    expect(audit).toBe(1);

    // Someone else's connection needs integrations rights.
    const c = await tokensFor();
    const cook = await addMember(ctx, "kitchen", {}, "oauth-cook");
    const grant = (await listConnectedApps(ctx)).find((g) => g.client.clientName === "Revocable")!;
    await expectAppError(revokeConnectedApp(cook.ctx, grant.id), "FORBIDDEN");
    await expectAppError(listConnectedApps(cook.ctx), "FORBIDDEN");

    // The API switched off for the organization: no access.
    await getDb().organization.update({
      where: { id: ctx.organizationId },
      data: { disabledFeatures: ["settings.api"] },
    });
    expect((await mcpCall(c.access_token, ping)).status).toBe(404);
    await getDb().organization.update({
      where: { id: ctx.organizationId },
      data: { disabledFeatures: [] },
    });
    expect((await mcpCall(c.access_token, ping)).status).toBe(200);
  });
});
