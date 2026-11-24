import "server-only";
import { z } from "zod";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { featureOn } from "@/modules/features/access";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { forbidden, notFound } from "@/server/errors";
import { consumeRateLimit } from "@/server/rate-limit";
import {
  ACCESS_TTL_SECONDS,
  challengeLooksValid,
  CODE_TTL_SECONDS,
  MAX_REDIRECT_URIS,
  newAccessToken,
  newClientId,
  newCode,
  newRefreshToken,
  OAUTH_SCOPES,
  parseScopes,
  pkceMatches,
  redirectUriAllowed,
  redirectWith,
  REFRESH_TTL_SECONDS,
  sameResource,
  sha256,
  type OAuthScope,
} from "./rules";

/**
 * OAuth 2.1 for the MCP server (DECISIONS.md ADR-144). The app is both the
 * authorization server and the protected resource (/api/mcp):
 * - apps register themselves (dynamic client registration) as public
 *   clients and must use PKCE (S256);
 * - a signed-in person chooses the organization and what the app may do;
 *   the consent is a grant, and the app acts as that person with their
 *   access at each call — never more;
 * - codes last 10 minutes and work once; access tokens last an hour,
 *   refresh tokens 30 days and are replaced at each use. A code or refresh
 *   token used twice revokes the whole grant (it was copied);
 * - only hashes of codes and tokens are stored; tokens are bound to this
 *   server's MCP address (resource indicator).
 */

const API_FEATURE = "settings.api";

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string,
  ) {
    super(description);
  }
}

const base = () => getEnv().APP_URL.replace(/\/+$/, "");
export const issuer = () => base();
export const mcpResource = () => `${base()}/api/mcp`;
export const resourceMetadataUrl = () => `${base()}/.well-known/oauth-protected-resource/api/mcp`;

export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Food Ambassador",
  };
}

export function authorizationServerMetadata() {
  const b = base();
  return {
    issuer: issuer(),
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    revocation_endpoint: `${b}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...OAUTH_SCOPES],
    authorization_response_iss_parameter_supported: true,
  };
}

// ─── Client registration (RFC 7591) ───

const registration = z.object({
  client_name: z.string().trim().min(1).max(100).optional(),
  redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
  response_types: z.array(z.literal("code")).optional(),
});

export async function registerClient(body: unknown, clientIp: string) {
  const limit = await consumeRateLimit(`oauth-register:${clientIp}`, { window: 3600, max: 20 });
  if (!limit.allowed) throw new OAuthError(429, "slow_down", "Too many registrations");
  const parsed = registration.safeParse(body);
  if (!parsed.success) {
    const auth = (body as { token_endpoint_auth_method?: unknown })?.token_endpoint_auth_method;
    throw new OAuthError(
      400,
      "invalid_client_metadata",
      auth !== undefined && auth !== "none"
        ? "Only public clients (token_endpoint_auth_method none) with PKCE are supported"
        : "redirect_uris is required (1 to 10 addresses)",
    );
  }
  const uris = [...new Set(parsed.data.redirect_uris)];
  if (!uris.every(redirectUriAllowed))
    throw new OAuthError(
      400,
      "invalid_redirect_uri",
      "Redirect addresses must be https, or http on localhost, without a fragment",
    );
  const client = await withSystemTx((tx) =>
    tx.oAuthClient.create({
      data: {
        clientId: newClientId(),
        clientName: parsed.data.client_name ?? "MCP client",
        redirectUris: uris,
      },
    }),
  );
  return {
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
  };
}

// ─── Authorization (consent) ───

export type AuthorizeCheck =
  | {
      ok: true;
      client: { id: string; clientId: string; name: string };
      redirectUri: string;
      state: string | undefined;
      codeChallenge: string;
      scopes: OAuthScope[];
    }
  /** Shown to the person: the app or its redirect address cannot be trusted. */
  | { ok: false; show: string }
  /** Sent back to the app. */
  | { ok: false; redirect: string };

type Params = Record<string, string | undefined>;

export async function checkAuthorizeRequest(p: Params): Promise<AuthorizeCheck> {
  const client = p.client_id
    ? await withSystemTx((tx) => tx.oAuthClient.findUnique({ where: { clientId: p.client_id } }))
    : null;
  if (!client) return { ok: false, show: "UNKNOWN_CLIENT" };
  const redirectUri =
    p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri))
    return { ok: false, show: "BAD_REDIRECT" };
  const back = (error: string, description: string) => ({
    ok: false as const,
    redirect: redirectWith(redirectUri, {
      error,
      error_description: description,
      state: p.state,
      iss: issuer(),
    }),
  });
  if (p.response_type !== "code")
    return back("unsupported_response_type", "Only response_type=code is supported");
  if (
    !p.code_challenge ||
    p.code_challenge_method !== "S256" ||
    !challengeLooksValid(p.code_challenge)
  )
    return back("invalid_request", "PKCE with code_challenge_method=S256 is required");
  if (p.resource && !sameResource(p.resource, mcpResource()))
    return back("invalid_target", "Tokens are only issued for this server's MCP address");
  const scopes = parseScopes(p.scope);
  if (!scopes) return back("invalid_scope", `Scopes: ${OAUTH_SCOPES.join(", ")}`);
  return {
    ok: true,
    client: { id: client.id, clientId: client.clientId, name: client.clientName },
    redirectUri,
    state: p.state,
    codeChallenge: p.code_challenge,
    scopes,
  };
}

/** Organizations the person may connect: active member, API switched on. */
export async function consentOrganizations(userId: string) {
  const orgs = await withSystemTx((tx) =>
    tx.organization.findMany({
      where: { status: "ACTIVE", memberships: { some: { userId, status: "ACTIVE" } } },
      select: { id: true, slug: true, name: true, disabledFeatures: true },
      orderBy: { name: "asc" },
    }),
  );
  return orgs
    .filter((o) => featureOn({ disabledFeatures: o.disabledFeatures }, API_FEATURE))
    .map((o) => ({ id: o.id, slug: o.slug, name: o.name }));
}

/** The person approves: a grant and a one-time code, then back to the app. */
export async function approveAuthorization(
  userId: string,
  p: Params,
  choice: { organizationId: string; scopes: string[] },
): Promise<string> {
  const check = await checkAuthorizeRequest(p);
  if (!check.ok) {
    if ("redirect" in check) return check.redirect;
    throw notFound("OAuth client");
  }
  const orgs = await consentOrganizations(userId);
  const org = orgs.find((o) => o.id === choice.organizationId);
  if (!org) throw forbidden();
  const scopes = check.scopes.filter((s) => choice.scopes.includes(s));
  if (scopes.length === 0) throw forbidden();
  const ctx = await withSystemTx((tx) => resolveTenantContext(tx, userId, org.slug));
  if (!ctx) throw forbidden();
  const code = newCode();
  await withTenantTx(ctx.organizationId, async (tx) => {
    const grant = await tx.oAuthGrant.create({
      data: {
        organizationId: ctx.organizationId,
        userId,
        clientId: check.client.id,
        scopes,
        resource: mcpResource(),
      },
    });
    await tx.oAuthCode.create({
      data: {
        organizationId: ctx.organizationId,
        grantId: grant.id,
        codeHash: sha256(code),
        redirectUri: check.redirectUri,
        codeChallenge: check.codeChallenge,
        expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "oauth_grant.created",
      entityType: "oauth_grant",
      entityId: grant.id,
      changes: { client: check.client.name, clientId: check.client.clientId, scopes },
    });
  });
  return redirectWith(check.redirectUri, { code, state: check.state, iss: issuer() });
}

export async function denyAuthorization(p: Params): Promise<string | null> {
  const check = await checkAuthorizeRequest(p);
  if (!check.ok) return "redirect" in check ? check.redirect : null;
  return redirectWith(check.redirectUri, {
    error: "access_denied",
    error_description: "The person did not allow access",
    state: check.state,
    iss: issuer(),
  });
}

// ─── Tokens ───

async function revokeGrantInTx(tx: Tx, grantId: string, byUserId: string | null) {
  const now = new Date();
  await tx.oAuthGrant.updateMany({
    where: { id: grantId, revokedAt: null },
    data: { revokedAt: now, revokedByUserId: byUserId },
  });
  await tx.oAuthToken.updateMany({ where: { grantId, revokedAt: null }, data: { revokedAt: now } });
}

async function issueTokensInTx(
  tx: Tx,
  grant: { id: string; organizationId: string; scopes: string[] },
) {
  const access = newAccessToken();
  const refresh = newRefreshToken();
  const now = Date.now();
  await tx.oAuthToken.createMany({
    data: [
      {
        organizationId: grant.organizationId,
        grantId: grant.id,
        kind: "ACCESS",
        tokenHash: sha256(access),
        expiresAt: new Date(now + ACCESS_TTL_SECONDS * 1000),
      },
      {
        organizationId: grant.organizationId,
        grantId: grant.id,
        kind: "REFRESH",
        tokenHash: sha256(refresh),
        expiresAt: new Date(now + REFRESH_TTL_SECONDS * 1000),
      },
    ],
  });
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh,
    scope: grant.scopes.join(" "),
  };
}

const invalidGrant = (why: string) => new OAuthError(400, "invalid_grant", why);

/** POST /oauth/token: an authorization code or a refresh token, for tokens. */
export async function exchangeToken(form: URLSearchParams) {
  const get = (k: string) => form.get(k) ?? undefined;
  const grantType = get("grant_type");
  const clientId = get("client_id");
  if (!clientId) throw new OAuthError(401, "invalid_client", "client_id is required");
  const resource = get("resource");
  if (resource && !sameResource(resource, mcpResource()))
    throw new OAuthError(
      400,
      "invalid_target",
      "Tokens are only issued for this server's MCP address",
    );

  if (grantType === "authorization_code") {
    const code = get("code");
    const verifier = get("code_verifier");
    if (!code || !verifier)
      throw new OAuthError(400, "invalid_request", "code and code_verifier are required");
    const result = await withSystemTx(async (tx) => {
      const row = await tx.oAuthCode.findUnique({
        where: { codeHash: sha256(code) },
        include: { grant: { include: { client: true } } },
      });
      if (!row) return { error: "The code is not valid" };
      if (row.usedAt) {
        // Used twice: someone else may hold it.
        await revokeGrantInTx(tx, row.grantId, null);
        return { error: "The code was already used" };
      }
      await tx.oAuthCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
      if (row.expiresAt < new Date()) return { error: "The code has expired" };
      if (row.grant.client.clientId !== clientId)
        return { error: "The code was issued to another client" };
      if (get("redirect_uri") !== undefined && get("redirect_uri") !== row.redirectUri)
        return { error: "redirect_uri does not match" };
      if (!pkceMatches(verifier, row.codeChallenge))
        return { error: "code_verifier does not match" };
      if (row.grant.revokedAt) return { error: "Access was revoked" };
      return { tokens: await issueTokensInTx(tx, row.grant) };
    });
    if ("error" in result) throw invalidGrant(result.error!);
    return result.tokens;
  }

  if (grantType === "refresh_token") {
    const token = get("refresh_token");
    if (!token) throw new OAuthError(400, "invalid_request", "refresh_token is required");
    const result = await withSystemTx(async (tx) => {
      const row = await tx.oAuthToken.findUnique({
        where: { tokenHash: sha256(token) },
        include: { grant: { include: { client: true } } },
      });
      if (!row || row.kind !== "REFRESH") return { error: "The refresh token is not valid" };
      if (row.grant.client.clientId !== clientId)
        return { error: "The token was issued to another client" };
      if (row.revokedAt) {
        // A replaced refresh token came back: revoke everything for this grant.
        if (!row.grant.revokedAt) await revokeGrantInTx(tx, row.grantId, null);
        return { error: "The refresh token was already used or revoked" };
      }
      if (row.expiresAt < new Date()) return { error: "The refresh token has expired" };
      if (row.grant.revokedAt) return { error: "Access was revoked" };
      await tx.oAuthToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
      return { tokens: await issueTokensInTx(tx, row.grant) };
    });
    if ("error" in result) throw invalidGrant(result.error!);
    return result.tokens;
  }
  throw new OAuthError(
    400,
    "unsupported_grant_type",
    "grant_type must be authorization_code or refresh_token",
  );
}

/** POST /oauth/revoke (RFC 7009): a refresh token ends the grant; an access token itself. */
export async function revokeToken(form: URLSearchParams) {
  const token = form.get("token");
  if (!token) return;
  await withSystemTx(async (tx) => {
    const row = await tx.oAuthToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.revokedAt) return;
    if (row.kind === "REFRESH") await revokeGrantInTx(tx, row.grantId, null);
    else await tx.oAuthToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  });
}

/**
 * An access token at the MCP server: valid, for this server, its grant and
 * organization active and the API switched on. The person's access is then
 * resolved by the caller.
 */
export async function authenticateAccessToken(token: string) {
  const row = await withSystemTx((tx) =>
    tx.oAuthToken.findUnique({
      where: { tokenHash: sha256(token) },
      include: {
        grant: true,
        organization: { select: { slug: true, status: true, disabledFeatures: true } },
      },
    }),
  );
  if (
    !row ||
    row.kind !== "ACCESS" ||
    row.revokedAt ||
    row.expiresAt < new Date() ||
    row.grant.revokedAt ||
    row.organization.status !== "ACTIVE" ||
    !sameResource(row.grant.resource, mcpResource())
  )
    return null;
  const limit = await consumeRateLimit(`mcp-oauth:${row.grantId}`, { window: 60, max: 600 });
  if (!limit.allowed) return { rateLimited: true as const, retryAfter: limit.retryAfter ?? 60 };
  if (!row.grant.lastUsedAt || Date.now() - row.grant.lastUsedAt.getTime() > 60_000)
    await withSystemTx((tx) =>
      tx.oAuthGrant.update({ where: { id: row.grantId }, data: { lastUsedAt: new Date() } }),
    );
  return {
    rateLimited: false as const,
    grantId: row.grantId,
    userId: row.grant.userId,
    scopes: row.grant.scopes,
    organizationSlug: row.organization.slug,
    apiOn: featureOn({ disabledFeatures: row.organization.disabledFeatures }, API_FEATURE),
  };
}

// ─── Connected apps ───

const grantSelect = {
  id: true,
  userId: true,
  scopes: true,
  createdAt: true,
  lastUsedAt: true,
  client: { select: { clientName: true, redirectUris: true } },
} as const;

/** Every app connected to the organization (people who manage integrations). */
export async function listConnectedApps(ctx: TenantContext) {
  assertPermission(ctx.grants, "integrations.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const grants = await tx.oAuthGrant.findMany({
      where: { organizationId: ctx.organizationId, revokedAt: null },
      select: grantSelect,
      orderBy: { createdAt: "desc" },
    });
    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(grants.map((g) => g.userId))] } },
      select: { id: true, name: true },
    });
    return grants.map((g) => ({
      ...g,
      userName: users.find((u) => u.id === g.userId)?.name ?? "—",
    }));
  });
}

/** Revoke a connection: the person's own, or any by someone who manages integrations. */
export async function revokeConnectedApp(ctx: TenantContext, grantId: string) {
  if (!z.uuid().safeParse(grantId).success) throw notFound("Connected app");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const g = await tx.oAuthGrant.findFirst({
      where: { organizationId: ctx.organizationId, id: grantId },
      include: { client: { select: { clientName: true } } },
    });
    if (!g) throw notFound("Connected app");
    if (g.userId !== ctx.userId && !hasPermission(ctx.grants, "integrations.manage"))
      throw forbidden();
    if (g.revokedAt) return;
    await revokeGrantInTx(tx, g.id, ctx.userId);
    await recordAudit(tx, actorOf(ctx), {
      action: "oauth_grant.revoked",
      entityType: "oauth_grant",
      entityId: g.id,
      changes: { client: g.client.clientName },
    });
  });
}

/** The person's own connected apps across organizations (account page). */
export async function listMyConnectedApps(userId: string) {
  return withSystemTx((tx) =>
    tx.oAuthGrant.findMany({
      where: { userId, revokedAt: null, organization: { status: "ACTIVE" } },
      select: { ...grantSelect, organization: { select: { slug: true, name: true } } },
      orderBy: { createdAt: "desc" },
    }),
  );
}
