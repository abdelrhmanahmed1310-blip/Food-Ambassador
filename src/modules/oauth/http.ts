import "server-only";
import { OAuthError } from "./service";

/**
 * Responses for the OAuth endpoints (ADR-144): JSON, never cached, and open
 * to browser-based clients (no cookies are read, so any origin may call).
 */
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export const oauthJson = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...CORS,
      ...headers,
    },
  });

export const preflight = () => new Response(null, { status: 204, headers: CORS });

/** OAuth errors as RFC 6749 bodies; anything else is a 500 without details. */
export async function oauthHandle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof OAuthError)
      return oauthJson(error.status, { error: error.error, error_description: error.description });
    console.error(error instanceof Error ? error.message : error);
    return oauthJson(500, { error: "server_error" });
  }
}

/** A form body (application/x-www-form-urlencoded) of at most 64 KB. */
export async function readForm(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (Buffer.byteLength(text) > 64 * 1024)
    throw new OAuthError(413, "invalid_request", "The body is too large");
  if (/^application\/json\b/i.test(type)) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(
        Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])),
      );
    } catch {
      throw new OAuthError(400, "invalid_request", "The body is not valid");
    }
  }
  return new URLSearchParams(text);
}
