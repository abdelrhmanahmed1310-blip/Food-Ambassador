import { describe, expect, it } from "vitest";
import { limitWindow, monthOf, readLimits, remaining, usageLimitsSchema } from "./rules";

/** Usage metering rules (ADR-146). */

describe("usage rules", () => {
  it("reads limits: empty is no limit, bad stored values fall back to none", () => {
    expect(
      usageLimitsSchema.parse({
        agentActionsPerMonth: "",
        aiTokensPerMonth: "500000",
        mcpCallsPerDay: "0",
      }),
    ).toEqual({ agentActionsPerMonth: null, aiTokensPerMonth: 500000, mcpCallsPerDay: 0 });
    expect(usageLimitsSchema.safeParse({ mcpCallsPerDay: "-1" }).success).toBe(false);
    // A stored "no limit" stays no limit.
    expect(readLimits({ agentActionsPerMonth: null, aiTokensPerMonth: 0 })).toEqual({
      agentActionsPerMonth: null,
      aiTokensPerMonth: 0,
      mcpCallsPerDay: null,
    });
    expect(readLimits({ aiTokensPerMonth: "lots" })).toEqual({
      agentActionsPerMonth: null,
      aiTokensPerMonth: null,
      mcpCallsPerDay: null,
    });
  });

  it("counts months and days in the organization's calendar", () => {
    expect(monthOf("2028-02-14")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
      month: "2028-02",
    });
    expect(monthOf("2026-12-31").to).toBe("2026-12-31");
    expect(limitWindow("mcpCallsPerDay", "2026-11-25")).toEqual({
      from: "2026-11-25",
      to: "2026-11-25",
    });
    expect(limitWindow("aiTokensPerMonth", "2026-11-25")).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect([remaining(null, 5), remaining(10, 4), remaining(3, 9)]).toEqual([null, 6, 0]);
  });
});
