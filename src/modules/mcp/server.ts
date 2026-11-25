import "server-only";
import { authenticateApiRequest } from "@/modules/api/clients";
import { MCP_SCOPES } from "@/modules/api/scopes";
import { featureOn } from "@/modules/features/access";
import { authenticateAccessToken } from "@/modules/oauth/service";
import { recordUsage, withinLimit } from "@/modules/usage/service";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { withSystemTx } from "@/server/db/transactions";
import type { ToolHost } from "./protocol";
import { toolsFor } from "./tools";

/**
 * Who is calling the MCP server (DECISIONS.md ADR-143, ADR-144): an OAuth
 * access token from an app the person connected, or an API key (ADR-090)
 * with at least one MCP scope, organization-wide, of an organization with the
 * API switched on. The key acts as the person who created it, with that
 * person's access now — resolved on every request, so removed access or a
 * suspended member stops the key at once. Everything it changes carries the
 * request id `mcp:<key id>` in the audit log.
 */

export type McpAuth =
  | { ok: true; ctx: TenantContext; scopes: string[]; clientId: string }
  | { ok: false; status: 401 | 403 | 404 | 429; message: string; retryAfter?: number };

/** An OAuth access token (ADR-144): the grant's person, with their access now. */
async function authenticateOAuth(token: string): Promise<McpAuth> {
  const t = await authenticateAccessToken(token);
  if (!t)
    return { ok: false, status: 401, message: "The access token is not valid or has expired" };
  if (t.rateLimited)
    return { ok: false, status: 429, message: "Too many requests", retryAfter: t.retryAfter };
  if (!t.apiOn)
    return { ok: false, status: 404, message: "The API is switched off for the organization" };
  const ctx = await withSystemTx((tx) =>
    resolveTenantContext(tx, t.userId, t.organizationSlug, `mcp-oauth:${t.grantId}`),
  );
  if (!ctx)
    return {
      ok: false,
      status: 403,
      message: "The person who connected this app no longer has access to the organization",
    };
  return { ok: true, ctx, scopes: t.scopes, clientId: t.grantId };
}

export async function authenticateMcp(authorization: string | null): Promise<McpAuth> {
  const bearer = /^Bearer (fao_[A-Za-z0-9_-]{20,})$/.exec(authorization?.trim() ?? "");
  if (bearer) return authenticateOAuth(bearer[1]);
  const auth = await authenticateApiRequest(authorization);
  if (!auth.ok)
    return auth.status === 429
      ? { ok: false, status: 429, message: "Too many requests", retryAfter: auth.retryAfter }
      : {
          ok: false,
          status: 401,
          message: "A valid API key is required (Authorization: Bearer fa_…)",
        };
  const { api } = auth;
  const scopes = api.scopes.filter((s) => (MCP_SCOPES as readonly string[]).includes(s));
  if (scopes.length === 0)
    return { ok: false, status: 403, message: "This key has no MCP scope (mcp:read, mcp:decide)" };
  if (api.companyId)
    return { ok: false, status: 403, message: "MCP keys cannot be limited to a company" };
  if (!featureOn(api.ctx, "settings.api"))
    return { ok: false, status: 404, message: "The API is switched off for the organization" };
  const ctx = await withSystemTx((tx) =>
    resolveTenantContext(tx, api.ctx.userId, api.ctx.organizationSlug, `mcp:${api.clientId}`),
  );
  if (!ctx)
    return {
      ok: false,
      status: 403,
      message: "The person who created this key no longer has access to the organization",
    };
  return { ok: true, ctx, scopes, clientId: api.clientId };
}

/** The tools this caller may see and call. */
export function toolHost(ctx: TenantContext, scopes: readonly string[]): ToolHost {
  const tools = toolsFor(ctx, scopes);
  return {
    list: () => tools,
    async call(name, input) {
      const t = tools.find((x) => x.name === name);
      if (!t) return null;
      // The organization's daily MCP call limit (ADR-146).
      if (!(await withinLimit(ctx.organizationId, "mcpCallsPerDay")))
        return { ok: false, error: "The organization's daily limit for MCP calls is reached." };
      const r = await t.run(ctx, input);
      await recordUsage(ctx.organizationId, "mcp.calls", 1, name, ctx.timeZone);
      return r;
    },
  };
}
