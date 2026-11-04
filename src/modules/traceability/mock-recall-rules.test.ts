import { describe, expect, it } from "vitest";
import { mockRecallOutcome, splitElapsed } from "./mock-recall-rules";

const base = {
  received: "100",
  exited: "60",
  book: "40",
  found: "40",
  gapCount: 0,
  originKnown: true,
  elapsedSeconds: 50 * 60,
  targetMinutes: 240,
};

describe("mock recall outcome (ADR-100)", () => {
  it("passes when everything is accounted for within the target", () => {
    const o = mockRecallOutcome(base);
    expect(o.problems).toEqual([]);
    expect(o.accountedPercent?.toFixed(2)).toBe("100.00");
    expect(o.withinTarget).toBe(true);
  });

  it("reports missing stock, the share accounted for and a missed target", () => {
    const o = mockRecallOutcome({ ...base, found: "37.5", elapsedSeconds: 241 * 60 });
    expect(o.difference.toFixed()).toBe("-2.5");
    expect(o.accountedPercent?.toFixed(2)).toBe("97.50");
    expect(o.problems).toEqual(["TARGET_MISSED", "STOCK_DIFFERENCE", "NOT_ACCOUNTED"]);
  });

  it("the target is inclusive; no target means no target verdict", () => {
    expect(mockRecallOutcome({ ...base, elapsedSeconds: 240 * 60 }).withinTarget).toBe(true);
    expect(mockRecallOutcome({ ...base, targetMinutes: null }).withinTarget).toBeNull();
  });

  it("flags trace gaps, an unknown origin and nothing received", () => {
    const o = mockRecallOutcome({
      ...base,
      received: "0",
      exited: "0",
      book: "0",
      found: "0",
      gapCount: 2,
      originKnown: false,
    });
    expect(o.accountedPercent).toBeNull();
    expect(o.problems).toEqual(["TRACE_GAPS", "ORIGIN_UNKNOWN"]);
  });

  it("splits elapsed time", () => {
    expect(splitElapsed(125 * 60 + 59)).toEqual({ hours: 2, minutes: 5 });
    expect(splitElapsed(-3)).toEqual({ hours: 0, minutes: 0 });
  });
});
