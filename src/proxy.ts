import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { CLIENT_IP_HEADER, clientIpFrom, trustedHopsFromEnv } from "@/lib/client-ip";
import { contentSecurityPolicy, newNonce } from "@/lib/csp";

const REQUEST_ID_HEADER = "x-request-id";
/** Routes that send their own, stricter policy (attachment downloads: sandboxed, ADR-051). */
const OWN_POLICY = /^\/o\/[^/]+\/attachments\/[^/]+$/;

/**
 * Runs before routing. Three jobs only:
 * 1. Attach a request ID (kept from the load balancer if present) for log correlation,
 *    and the client IP derived from trusted proxy hops (overwriting any value
 *    the client sent), used for rate limiting.
 * 2. Send visitors without a session cookie away from tenant pages early.
 *    This is a UX shortcut, NOT the security boundary: every page and action
 *    validates the session and membership on the server (requireTenant).
 * 3. Set the Content Security Policy with a fresh script nonce (ADR-074). Next.js
 *    reads the nonce from the request header and puts it on its own scripts.
 */
export function proxy(request: NextRequest) {
  const incoming = request.headers.get(REQUEST_ID_HEADER);
  const requestId = incoming && /^[\w-]{8,128}$/.test(incoming) ? incoming : crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  const csp = OWN_POLICY.test(request.nextUrl.pathname)
    ? null
    : contentSecurityPolicy(newNonce(), process.env.NODE_ENV === "development");
  if (csp) headers.set("content-security-policy", csp);
  headers.set(
    CLIENT_IP_HEADER,
    clientIpFrom(
      request.headers.get("x-forwarded-for"),
      trustedHopsFromEnv(process.env.TRUSTED_PROXY_HOPS),
    ),
  );

  if (request.nextUrl.pathname.startsWith("/o/") && !getSessionCookie(request)) {
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set("next", request.nextUrl.pathname);
    const response = NextResponse.redirect(signIn);
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  }

  const response = NextResponse.next({ request: { headers } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  if (csp) response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
