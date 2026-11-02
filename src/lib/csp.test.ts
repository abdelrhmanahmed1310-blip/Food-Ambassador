import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, newNonce } from "./csp";

describe("content security policy (ADR-074)", () => {
  it("makes a fresh, unguessable nonce each time", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64")).toHaveLength(16);
  });

  it("allows only scripts with the nonce, and never inline or eval in production", () => {
    const p = contentSecurityPolicy("abc", false);
    const script = p.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(script).toBe("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(script).not.toContain("unsafe-inline");
    expect(p).not.toContain("unsafe-eval");
    expect(p).toContain("object-src 'none'");
    expect(p).toContain("frame-ancestors 'none'");
    expect(p).toContain("base-uri 'self'");
    expect(p).toContain("form-action 'self'");
  });

  it("adds eval only for the development server", () => {
    expect(contentSecurityPolicy("abc", true)).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy("abc", true)).not.toContain("upgrade-insecure-requests");
  });
});
