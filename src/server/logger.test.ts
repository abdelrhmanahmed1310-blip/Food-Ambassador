import { describe, expect, it } from "vitest";
import { createLogger, redact, type LogLevel } from "./logger";

function capture(level: LogLevel = "debug") {
  const lines: Array<Record<string, unknown>> = [];
  const log = createLogger({ level, sink: (line) => lines.push(JSON.parse(line)) });
  return { log, lines };
}

describe("logger", () => {
  it("writes structured JSON with level, message and fields", () => {
    const { log, lines } = capture();
    log.info("stock posted", { organizationId: "org_1", quantity: "5" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      message: "stock posted",
      organizationId: "org_1",
      quantity: "5",
    });
    expect(typeof lines[0].time).toBe("string");
  });

  it("filters below the configured level", () => {
    const { log, lines } = capture("warn");
    log.debug("hidden");
    log.info("hidden");
    log.warn("shown");
    log.error("shown");
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("redacts secrets, including nested and differently-cased keys", () => {
    const { log, lines } = capture();
    log.info("login", {
      password: "hunter2",
      user: { passwordHash: "abc", email: "a@example.com" },
      headers: { Authorization: "Bearer x", Cookie: "sid=1", "x-api-key": "k" },
      sessionToken: "t",
    });
    const serialized = JSON.stringify(lines[0]);
    for (const secret of ["hunter2", "abc", "Bearer x", "sid=1", '"k"', '"t"']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("a@example.com");
  });

  it("includes child bindings", () => {
    const { log, lines } = capture();
    log.child({ requestId: "req_1" }).info("handled");
    expect(lines[0]).toMatchObject({ requestId: "req_1", message: "handled" });
  });

  it("serializes errors and bounds depth", () => {
    const out = redact({ error: new Error("boom") }) as { error: { message: string } };
    expect(out.error.message).toBe("boom");
    type Nested = { next?: Nested };
    const deep: Nested = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) cursor = cursor.next = {};
    expect(JSON.stringify(redact(deep))).toContain("[Truncated]");
  });
});
