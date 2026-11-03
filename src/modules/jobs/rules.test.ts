import { describe, expect, it } from "vitest";
import { jobRetryDelaySeconds, localDateHour, slotKey } from "./rules";

describe("job runner rules (ADR-087)", () => {
  it("backs off and caps the retry delay", () => {
    expect([1, 2, 3, 4, 5, 9].map(jobRetryDelaySeconds)).toEqual([
      60, 300, 1800, 7200, 43200, 43200,
    ]);
  });

  it("puts every run inside one slot under the same key", () => {
    const a = slotKey(new Date("2026-11-03T10:01:10Z"), 10);
    const b = slotKey(new Date("2026-11-03T10:09:59Z"), 10);
    const c = slotKey(new Date("2026-11-03T10:10:00Z"), 10);
    expect(a).toBe("2026-11-03T10:00");
    expect(b).toBe(a);
    expect(c).toBe("2026-11-03T10:10");
  });

  it("reads the local day and hour of the organization", () => {
    // 21:30 UTC is already the next day in Riyadh (UTC+3).
    expect(localDateHour(new Date("2026-11-02T21:30:00Z"), "Asia/Riyadh")).toEqual({
      date: "2026-11-03",
      hour: 0,
    });
    expect(localDateHour(new Date("2026-11-03T04:00:00Z"), "Africa/Cairo").date).toBe("2026-11-03");
  });
});
