import { describe, expect, it, vi } from "vitest";
import { checkReadiness } from "./health";

describe("checkReadiness", () => {
  it("reports ok when all probes succeed", async () => {
    const report = await checkReadiness({ database: async () => {}, cache: async () => {} });
    expect(report.status).toBe("ok");
    expect(report.checks.database.status).toBe("ok");
    expect(report.checks.cache.status).toBe("ok");
  });

  it("reports unavailable and calls onError without exposing the error", async () => {
    const onError = vi.fn();
    const report = await checkReadiness(
      {
        database: async () =>
          Promise.reject(new Error("password authentication failed for user food")),
      },
      { onError },
    );
    expect(report.status).toBe("unavailable");
    expect(report.checks.database.status).toBe("fail");
    expect(onError).toHaveBeenCalledWith("database", expect.any(Error));
    expect(JSON.stringify(report)).not.toContain("password");
  });

  it("fails a probe that exceeds the timeout", async () => {
    const report = await checkReadiness(
      { database: () => new Promise<void>((resolve) => setTimeout(resolve, 500)) },
      { timeoutMs: 20 },
    );
    expect(report.checks.database.status).toBe("fail");
  });
});
