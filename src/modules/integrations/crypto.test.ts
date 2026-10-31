import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  integrationKey,
  isPrivateAddress,
  newSecret,
  retryDelaySeconds,
  sign,
  urlProblem,
  verifySignature,
} from "./crypto";

const key = integrationKey(undefined, "x".repeat(40));

describe("connector secrets", () => {
  it("encrypt and decrypt with authentication; a changed byte or key fails", () => {
    const secret = newSecret();
    expect(secret).toMatch(/^fa_whsec_[\w-]{43}$/);
    const sealed = encryptSecret(secret, key);
    expect(sealed).not.toContain(secret);
    expect(decryptSecret(sealed, key)).toBe(secret);
    expect(encryptSecret(secret, key)).not.toBe(sealed); // random IV
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 0x01; // always a real change, whatever the random ciphertext is
    const tampered = [...parts.slice(0, 3), ct.toString("base64url")].join(".");
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(() => decryptSecret(sealed, integrationKey(undefined, "y".repeat(40)))).toThrow();
    const configured = Buffer.alloc(32, 7).toString("base64");
    expect(integrationKey(configured, "ignored").equals(Buffer.alloc(32, 7))).toBe(true);
  });
});

describe("webhook signatures", () => {
  const body = '{"lines":[]}';
  it("accept the right signature within five minutes and nothing else", () => {
    const ts = "1700000000";
    const signature = sign("s3cret", ts, body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    const check = (o: Partial<Parameters<typeof verifySignature>[0]>) =>
      verifySignature({
        secret: "s3cret",
        timestamp: ts,
        signature,
        body,
        nowSeconds: 1700000100,
        ...o,
      });
    expect(check({})).toBe("OK");
    expect(check({ body: '{"lines":[1]}' })).toBe("MISMATCH");
    expect(check({ secret: "other" })).toBe("MISMATCH");
    expect(check({ nowSeconds: 1700000301 })).toBe("STALE");
    expect(check({ signature: null })).toBe("MISSING");
    expect(check({ timestamp: "17e8" })).toBe("STALE");
  });

  it("back off and give up after five retries", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelaySeconds)).toEqual([60, 300, 1800, 7200, 43200, null]);
  });
});

describe("outbound URL safety", () => {
  it("requires https and refuses private, loopback and metadata addresses", () => {
    expect(urlProblem("https://hooks.example.com/x", ["93.184.216.34"], false)).toBeNull();
    expect(urlProblem("http://hooks.example.com/x", ["93.184.216.34"], false)).toBe(
      "httpsRequired",
    );
    expect(urlProblem("https://hooks.example.com/x", ["10.0.0.5"], false)).toBe("privateAddress");
    expect(urlProblem("https://x/", ["169.254.169.254"], false)).toBe("privateAddress");
    expect(urlProblem("https://x/", [], false)).toBe("unresolvable");
    expect(urlProblem("https://user:pw@x/", ["93.184.216.34"], false)).toBe("credentialsInUrl");
    expect(urlProblem("http://127.0.0.1:9999/hook", ["127.0.0.1"], true)).toBeNull();
    expect(urlProblem("ftp://x/", [], true)).toBe("httpsRequired");
    for (const a of [
      "127.0.0.1",
      "192.168.1.1",
      "172.20.0.1",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
      "not-an-ip",
    ])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["8.8.8.8", "172.32.0.1", "2001:4860:4860::8888"])
      expect(isPrivateAddress(a), a).toBe(false);
  });
});
