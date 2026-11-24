import { oauthJson, preflight } from "@/modules/oauth/http";
import { authorizationServerMetadata } from "@/modules/oauth/service";

/** Authorization server metadata (RFC 8414, ADR-144). */
export function GET() {
  return oauthJson(200, authorizationServerMetadata());
}

export function OPTIONS() {
  return preflight();
}
