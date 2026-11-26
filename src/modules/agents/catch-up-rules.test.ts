import { describe, expect, it } from "vitest";
import { daysToCheck } from "./catch-up-rules";

/** The daily close catches up skipped days (ADR-159). */

describe("days the daily close checks", () => {
  it("checks every day since the last one, oldest first", () => {
    expect(daysToCheck("2026-11-25", "2026-11-22", new Set())).toEqual([
      "2026-11-23",
      "2026-11-24",
      "2026-11-25",
    ]);
  });

  it("checks yesterday only the first time, and nothing already checked", () => {
    expect(daysToCheck("2026-11-25", null, new Set())).toEqual(["2026-11-25"]);
    expect(daysToCheck("2026-11-25", "2026-11-25", new Set())).toEqual([]);
    expect(daysToCheck("2026-11-25", "2026-11-22", new Set(["2026-11-24"]))).toEqual([
      "2026-11-23",
      "2026-11-25",
    ]);
  });

  it("goes back at most seven days", () => {
    expect(daysToCheck("2026-11-25", "2026-10-01", new Set())).toEqual([
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
      "2026-11-22",
      "2026-11-23",
      "2026-11-24",
      "2026-11-25",
    ]);
  });
});
