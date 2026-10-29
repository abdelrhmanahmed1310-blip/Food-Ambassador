import { describe, expect, it } from "vitest";
import { clientIpFrom, trustedHopsFromEnv } from "./client-ip";

describe("clientIpFrom", () => {
  it("uses the entry appended by the trusted proxy, ignoring spoofed prefixes", () => {
    expect(clientIpFrom("6.6.6.6, 203.0.113.7", 1)).toBe("203.0.113.7");
    expect(clientIpFrom("6.6.6.6, 203.0.113.7, 10.0.0.2", 2)).toBe("203.0.113.7");
  });

  it("returns unknown without proxies or headers", () => {
    expect(clientIpFrom("203.0.113.7", 0)).toBe("unknown");
    expect(clientIpFrom(null, 1)).toBe("unknown");
    expect(clientIpFrom("203.0.113.7", 3)).toBe("unknown");
  });

  it("parses the hop count defensively", () => {
    expect(trustedHopsFromEnv(undefined)).toBe(1);
    expect(trustedHopsFromEnv("0")).toBe(0);
    expect(trustedHopsFromEnv("abc")).toBe(1);
    expect(trustedHopsFromEnv("-2")).toBe(1);
  });
});
