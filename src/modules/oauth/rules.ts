import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth 2.1 rules for the MCP server (DECISIONS.md ADR-144). Pure: what a
 * redirect address may be, PKCE, scopes, token shapes and lifetimes.
 */

export const OAUTH_SCOPES = ["mcp:read", "mcp:decide"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const CODE_TTL_SECONDS = 10 * 60;
export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MAX_REDIRECT_URIS = 10;

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const random = (bytes: number) => randomBytes(bytes).toString("base64url");

/** Public client id, authorization code, access and refresh tokens. */
export const newClientId = () => `fac_${random(18)}`;
export const newCode = () => random(32);
export const newAccessToken = () => `fao_${random(32)}`;
export const newRefreshToken = () => `far_${random(32)}`;

/**
 * A redirect address an app may register: https anywhere, or http on the
 * loopback address only (native and command-line apps). No fragment, no
 * credentials in the address.
 */
export function redirectUriAllowed(value: string): boolean {
  if (value.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/** PKCE S256: base64url(SHA-256(verifier)) equals the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

export const challengeLooksValid = (challenge: string) => /^[A-Za-z0-9_-]{43}$/.test(challenge);

/** Requested scopes, known ones only; mcp:read when none are asked for. */
export function parseScopes(raw: string | null | undefined): OAuthScope[] | null {
  const asked = (raw ?? "").split(/\s+/).filter(Boolean);
  if (asked.length === 0) return ["mcp:read"];
  if (asked.some((s) => !(OAUTH_SCOPES as readonly string[]).includes(s))) return null;
  return OAUTH_SCOPES.filter((s) => asked.includes(s));
}

/** The resource indicator a client sent names this server (trailing slash ignored). */
export function sameResource(given: string, expected: string): boolean {
  const norm = (v: string) => v.replace(/\/+$/, "");
  return norm(given) === norm(expected);
}

/** A redirect back to the app with the result, keeping its own query. */
export function redirectWith(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
