import { oauthJson, preflight } from "@/modules/oauth/http";
import { protectedResourceMetadata } from "@/modules/oauth/service";

/** Protected resource metadata for the MCP server (RFC 9728, ADR-144), at the address-specific path.. */
export function GET() {
  return oauthJson(200, protectedResourceMetadata());
}

export function OPTIONS() {
  return preflight();
}
