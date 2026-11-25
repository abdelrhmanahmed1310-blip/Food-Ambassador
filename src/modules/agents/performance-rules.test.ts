import { describe, expect, it } from "vitest";
import { emptyMonth, monthsBack, summarize } from "./performance-rules";

/** Agent performance rules (ADR-150). */

const month = (m: string, over: Partial<ReturnType<typeof emptyMonth>>) => ({
  ...emptyMonth(m),
  ...over,
});

describe("agent performance", () => {
  it("lists months back across a year end", () => {
    expect(monthsBack("2027-02", 4)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });

  it("adds up the months and judges readiness only on enough decisions", () => {
    const few = summarize("MENU_MARGIN", [month("2026-10", { approved: 5, rejected: 0, runs: 3 })]);
    expect([few.readiness, few.approvalPercent, few.totals.runs]).toEqual(["TOO_FEW", 100, 3]);
    const none = summarize("MENU_MARGIN", [month("2026-10", {})]);
    expect([none.readiness, none.approvalPercent]).toEqual(["TOO_FEW", null]);
    const ready = summarize("REPLENISHMENT", [
      month("2026-10", { approved: 15, rejected: 1 }),
      month("2026-11", { approved: 10, rejected: 0 }),
    ]);
    expect([ready.readiness, ready.approvalPercent, ready.totals.approved]).toEqual([
      "READY",
      96,
      25,
    ]);
    // A rejection this month holds it back, however good the rate.
    const recent = summarize("REPLENISHMENT", [
      month("2026-10", { approved: 30 }),
      month("2026-11", { approved: 10, rejected: 1 }),
    ]);
    expect(recent.readiness).toBe("MIXED");
    const mixed = summarize("FOOD_SAFETY", [month("2026-11", { approved: 12, rejected: 10 })]);
    expect([mixed.readiness, mixed.approvalPercent]).toEqual(["MIXED", 55]);
  });
});
