import { describe, expect, it } from "vitest";
import { COMMON_LEAVE_TYPES, leaveDays, overlaps } from "./leave-rules";

describe("leave rules (ADR-081)", () => {
  it("counts calendar days with both ends included", () => {
    expect(leaveDays("2026-11-02", "2026-11-02")).toBe(1);
    expect(leaveDays("2026-11-02", "2026-11-08")).toBe(7);
    expect(leaveDays("2026-02-27", "2026-03-02")).toBe(4);
  });

  it("finds overlapping ranges, touching ends included", () => {
    expect(
      overlaps(
        { start: "2026-11-01", end: "2026-11-05" },
        { start: "2026-11-05", end: "2026-11-09" },
      ),
    ).toBe(true);
    expect(
      overlaps(
        { start: "2026-11-01", end: "2026-11-04" },
        { start: "2026-11-05", end: "2026-11-09" },
      ),
    ).toBe(false);
  });

  it("offers common types without inventing entitlements", () => {
    expect(COMMON_LEAVE_TYPES.map((t) => t.code)).toContain("HAJJ");
    expect(COMMON_LEAVE_TYPES.every((t) => !("days" in t))).toBe(true);
    expect(COMMON_LEAVE_TYPES.find((t) => t.code === "UNPAID")).toMatchObject({
      paid: false,
      usesBalance: false,
    });
  });
});
