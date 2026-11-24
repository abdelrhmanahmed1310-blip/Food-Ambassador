import { oauthHandle, oauthJson, preflight, readForm } from "@/modules/oauth/http";
import { exchangeToken } from "@/modules/oauth/service";

/** Token endpoint (ADR-144): authorization_code with PKCE, and refresh_token with rotation. */
export async function POST(request: Request) {
  return oauthHandle(async () => oauthJson(200, await exchangeToken(await readForm(request))));
}

export function OPTIONS() {
  return preflight();
}
