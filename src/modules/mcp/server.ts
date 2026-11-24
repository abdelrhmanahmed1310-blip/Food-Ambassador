import "server-only";
import { authenticateApiRequest } from "@/modules/api/clients";
import { MCP_SCOPES } from "@/modules/api/scopes";
import { featureOn } from "@/modules/features/access";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { withSystemTx } from "@/server/db/transactions";
import type { ToolHost } from "./protocol";
import { toolsFor } from "./tools";

/**
 * Who is calling the MCP server (DECISIONS.md ADR-143): an API key (ADR-090)
 * with at least one MCP scope, organization-wide, of an organization with the
 * API switched on. The key acts as the person who created it, with that
 * person's access now — resolved on every request, so removed access or a
 * suspended member stops the key at once. Everything it changes carries the
 * request id `mcp:<key id>` in the audit log.
 */

export type McpAuth =
  | { ok: true; ctx: TenantContext; scopes: string[]; clientId: string }
  | { ok: false; status: 401 | 403 | 404 | 429; message: string; retryAfter?: number };

export async function authenticateMcp(authorization: string | null): Promise<McpAuth> {
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
      return t ? t.run(ctx, input) : null;
    },
  };
}
