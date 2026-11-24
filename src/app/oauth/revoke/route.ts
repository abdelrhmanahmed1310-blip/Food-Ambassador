import { oauthHandle, preflight, readForm } from "@/modules/oauth/http";
import { CORS } from "@/modules/oauth/http";
import { revokeToken } from "@/modules/oauth/service";

/** Token revocation (RFC 7009, ADR-144): always 200, whether or not the token was known. */
export async function POST(request: Request) {
  return oauthHandle(async () => {
    await revokeToken(await readForm(request));
    return new Response(null, { status: 200, headers: { ...CORS, "Cache-Control": "no-store" } });
  });
}

export function OPTIONS() {
  return preflight();
}
