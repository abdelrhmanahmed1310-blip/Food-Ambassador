import { describe, expect, it } from "vitest";
import { allowedSteps, distribution, goalScore, weightsWithin } from "./rules";

describe("performance rules (ADR-126)", () => {
  it("moves a review forward only", () => {
    expect(allowedSteps("NOT_STARTED")).toEqual(["SELF", "MANAGER", "SKIP"]);
    expect(allowedSteps("SELF_DONE")).toEqual(["MANAGER", "SKIP"]);
    expect(allowedSteps("MANAGER_DONE")).toContain("ACKNOWLEDGE");
    expect(allowedSteps("ACKNOWLEDGED")).toEqual(["FINALIZE", "SKIP"]);
    expect(allowedSteps("FINALIZED")).toEqual([]);
  });

  it("keeps a cycle's goal weights within 100 %", () => {
    const goals = [
      { weight: 60, status: "OPEN" },
      { weight: 30, status: "ACHIEVED" },
      { weight: 50, status: "CANCELLED" },
    ];
    expect(weightsWithin(goals)).toBe(true);
    expect(weightsWithin(goals, 10)).toBe(true);
    expect(weightsWithin(goals, 11)).toBe(false);
  });

  it("scores goals by weight, or evenly when none carries weight", () => {
    expect(
      goalScore([
        { rating: 5, weight: 60 },
        { rating: 3, weight: 40 },
      ]),
    ).toBe(4.2);
    expect(
      goalScore([
        { rating: 4, weight: 0 },
        { rating: 3, weight: 0 },
      ]),
    ).toBe(3.5);
    expect(
      goalScore([
        { rating: null, weight: 50 },
        { rating: 2, weight: 50 },
      ]),
    ).toBe(2);
    expect(
      goalScore([
        { rating: 4, weight: 1 },
        { rating: 4, weight: 2 },
        { rating: 5, weight: 0 },
      ]),
    ).toBe(4);
    expect(goalScore([])).toBeNull();
  });

  it("counts final ratings, else the manager's", () => {
    expect(
      distribution([
        { finalRating: 4, managerRating: 3 },
        { finalRating: null, managerRating: 3 },
        { finalRating: null, managerRating: null },
      ]),
    ).toEqual({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 0 });
  });
});
