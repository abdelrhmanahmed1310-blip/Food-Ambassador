import { describe, expect, it } from "vitest";
import {
  digestFor,
  emptyWeek,
  isoWeekday,
  mondayOf,
  nextMonday,
  previousWeek,
} from "./digest-rules";

/** The weekly agent digest (ADR-153). */

describe("weekly agent digest rules", () => {
  it("reports on the Monday-to-Sunday week before a Monday", () => {
    expect(isoWeekday("2026-11-30")).toBe(1);
    expect(isoWeekday("2026-11-29")).toBe(7);
    expect(previousWeek("2026-11-30")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(previousWeek("2026-11-25")).toBeNull();
    expect(nextMonday("2026-11-25")).toBe("2026-11-30");
    expect(nextMonday("2026-11-30")).toBe("2026-12-07");
    expect(nextMonday("2026-12-28")).toBe("2027-01-04");
    expect(mondayOf("2026-11-25")).toBe("2026-11-23");
    expect(mondayOf("2026-11-29")).toBe("2026-11-23");
    expect(mondayOf("2026-11-30")).toBe("2026-11-30");
    expect(mondayOf("2027-01-01")).toBe("2026-12-28");
  });

  it("sums only the agents the person may see, and is null for a quiet week", () => {
    const byKind = new Map([
      ["DAILY_CLOSE", { ...emptyWeek(), runs: 7, critical: 2 }],
      ["REPLENISHMENT", { ...emptyWeek(), runs: 7, proposals: 3, approved: 2, rejected: 1 }],
    ] as const);
    expect(digestFor(byKind, ["DAILY_CLOSE", "FOOD_SAFETY"], 0)).toEqual({
      ...emptyWeek(),
      runs: 7,
      critical: 2,
      waiting: 0,
    });
    expect(digestFor(byKind, ["DAILY_CLOSE", "REPLENISHMENT"], 4)).toMatchObject({
      runs: 14,
      proposals: 3,
      approved: 2,
      rejected: 1,
      waiting: 4,
    });
    expect(digestFor(byKind, ["MENU_MARGIN"], 0)).toBeNull();
    expect(digestFor(byKind, ["MENU_MARGIN"], 1)).toMatchObject({ runs: 0, waiting: 1 });
  });
});
