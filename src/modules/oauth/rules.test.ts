import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseScopes, pkceMatches, redirectUriAllowed, redirectWith, sameResource } from "./rules";

/** OAuth rules for the MCP server (ADR-144). */

describe("OAuth rules", () => {
  it("accepts https and loopback redirect addresses only", () => {
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriAllowed("http://localhost:6274/oauth/callback")).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:33418/callback")).toBe(true);
    expect(redirectUriAllowed("http://example.com/callback")).toBe(false);
    expect(redirectUriAllowed("https://example.com/cb#frag")).toBe(false);
    expect(redirectUriAllowed("https://user:pw@example.com/cb")).toBe(false);
    expect(redirectUriAllowed("javascript:alert(1)")).toBe(false);
    expect(redirectUriAllowed("not a url")).toBe(false);
  });

  it("checks PKCE S256", () => {
    const verifier = "a".repeat(43) + "-._~";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(`${verifier}x`, challenge)).toBe(false);
    expect(pkceMatches("short", challenge)).toBe(false);
  });

  it("reads scopes, defaulting to read and refusing unknown ones", () => {
    expect(parseScopes(undefined)).toEqual(["mcp:read"]);
    expect(parseScopes("mcp:decide mcp:read")).toEqual(["mcp:read", "mcp:decide"]);
    expect(parseScopes("mcp:read admin")).toBeNull();
  });

  it("compares resources and builds redirects that keep the app's query", () => {
    expect(sameResource("https://x.test/api/mcp/", "https://x.test/api/mcp")).toBe(true);
    expect(sameResource("https://evil.test/api/mcp", "https://x.test/api/mcp")).toBe(false);
    expect(redirectWith("https://app.test/cb?x=1", { code: "c", state: undefined })).toBe(
      "https://app.test/cb?x=1&code=c",
    );
  });
});
