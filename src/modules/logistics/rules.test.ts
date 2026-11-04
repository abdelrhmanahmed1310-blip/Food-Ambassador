import { describe, expect, it } from "vitest";
import {
  allStopsResolved,
  distanceKm,
  isExcursion,
  isValidSignature,
  normalizeSignature,
} from "./rules";

describe("own fleet rules (ADR-116)", () => {
  it("flags temperatures outside a refrigerated vehicle's range only", () => {
    const chilled = { min: "0", max: "5" };
    expect([
      isExcursion("0", chilled),
      isExcursion("5", chilled),
      isExcursion("5.1", chilled),
      isExcursion("-0.5", chilled),
    ]).toEqual([false, false, true, true]);
    expect(isExcursion("30", { min: null, max: null })).toBe(false);
  });

  it("keeps signatures as plain line drawings", () => {
    expect(isValidSignature("M 10 20 L 30.4 40 L 55,61")).toBe(true);
    expect(normalizeSignature("M 10 20 L 30.4  40 L 55,61.6")).toBe("M 10 20 L 30 40 L 55,62");
    expect(isValidSignature('M 0 0 L 1 1"/><script>')).toBe(false);
    expect(isValidSignature("C 1 2 3 4 5 6")).toBe(false);
  });

  it("measures distance and knows when every stop is resolved", () => {
    expect([distanceKm(1200, 1342), distanceKm(1200, null), distanceKm(10, 5)]).toEqual([
      142,
      null,
      null,
    ]);
    expect(allStopsResolved([{ status: "DELIVERED" }, { status: "FAILED" }])).toBe(true);
    expect(allStopsResolved([{ status: "DELIVERED" }, { status: "PENDING" }])).toBe(false);
    expect(allStopsResolved([])).toBe(false);
  });
});
