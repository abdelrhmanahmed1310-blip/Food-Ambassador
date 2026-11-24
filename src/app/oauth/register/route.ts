import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { oauthHandle, oauthJson, preflight } from "@/modules/oauth/http";
import { OAuthError, registerClient } from "@/modules/oauth/service";

/** Dynamic client registration (RFC 7591, ADR-144): public clients with PKCE only. */
export async function POST(request: Request) {
  return oauthHandle(async () => {
    const text = await request.text();
    if (Buffer.byteLength(text) > 16 * 1024)
      throw new OAuthError(413, "invalid_client_metadata", "The body is too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError(400, "invalid_client_metadata", "Send the metadata as JSON");
    }
    const ip = request.headers.get(CLIENT_IP_HEADER) ?? "unknown";
    return oauthJson(201, await registerClient(body, ip));
  });
}

export function OPTIONS() {
  return preflight();
}
