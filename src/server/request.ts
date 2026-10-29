import "server-only";
import { headers } from "next/headers";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";

export const REQUEST_ID_HEADER = "x-request-id";

/** Request ID set by proxy.ts (or by the upstream load balancer). */
export async function getRequestId(): Promise<string | undefined> {
  return (await headers()).get(REQUEST_ID_HEADER) ?? undefined;
}

/** Client IP computed by proxy.ts from trusted X-Forwarded-For hops; for rate-limit keys only. */
export async function getClientIp(): Promise<string> {
  return (await headers()).get(CLIENT_IP_HEADER) ?? "unknown";
}
