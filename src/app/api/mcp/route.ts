import { handleBody, PROTOCOL_VERSIONS } from "@/modules/mcp/protocol";
import { authenticateMcp, toolHost } from "@/modules/mcp/server";

/**
 * MCP server for customers' own agents (DECISIONS.md ADR-143): Streamable
 * HTTP, stateless, JSON replies. POST /api/mcp with an API key holding an MCP
 * scope. No server-to-client stream is offered, so GET is refused.
 */

const MAX_BODY_BYTES = 1024 * 1024;
const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...headers } });
const rpcError = (status: number, code: number, message: string, headers = {}) =>
  json(status, { jsonrpc: "2.0", id: null, error: { code, message } }, headers);

/** Browsers send Origin; only our own is accepted (DNS rebinding). Servers send none. */
function originAllowed(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!originAllowed(request)) return rpcError(403, -32600, "Origin not allowed");
  const version = request.headers.get("mcp-protocol-version");
  if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version))
    return rpcError(400, -32600, `Unsupported MCP-Protocol-Version: ${version}`);
  const auth = await authenticateMcp(request.headers.get("authorization"));
  if (!auth.ok)
    return rpcError(
      auth.status,
      -32001,
      auth.message,
      auth.status === 401
        ? { "WWW-Authenticate": "Bearer" }
        : auth.status === 429
          ? { "Retry-After": String(auth.retryAfter ?? 60) }
          : {},
    );
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES)
    return rpcError(413, -32600, "The body is larger than 1 MB");
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    return rpcError(413, -32600, "The body is larger than 1 MB");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, -32700, "Parse error");
  }
  try {
    const reply = await handleBody(body, toolHost(auth.ctx, auth.scopes));
    return reply === null ? new Response(null, { status: 202 }) : json(200, reply);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return rpcError(500, -32603, "Internal error");
  }
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
