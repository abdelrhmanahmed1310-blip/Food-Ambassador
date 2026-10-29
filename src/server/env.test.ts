import { afterEach, describe, expect, it, vi } from "vitest";
import { getEnv, resetEnvCache } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("getEnv", () => {
  it("parses valid configuration", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/db");
    vi.stubEnv("LOG_LEVEL", "debug");
    vi.stubEnv("APP_URL", "https://app.example.com");
    const env = getEnv();
    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.APP_URL).toBe("https://app.example.com");
  });

  it("applies defaults for optional values", () => {
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/db");
    vi.stubEnv("LOG_LEVEL", undefined);
    vi.stubEnv("APP_URL", undefined);
    const env = getEnv();
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.APP_URL).toBe("http://localhost:3000");
  });

  it("rejects a missing or non-PostgreSQL DATABASE_URL without echoing it", () => {
    vi.stubEnv("DATABASE_URL", "mysql://secret-user:secret-pass@db/x");
    expect(() => getEnv()).toThrow(/DATABASE_URL must be a PostgreSQL URL/);
    resetEnvCache();
    try {
      getEnv();
    } catch (error) {
      expect(String(error)).not.toContain("secret-pass");
    }
  });
});
