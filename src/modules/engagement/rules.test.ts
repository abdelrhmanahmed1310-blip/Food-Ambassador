import { describe, expect, it } from "vitest";
import { enps, mayShow, ratingSummary, shuffled, validAnswer } from "./rules";

describe("engagement rules (ADR-127)", () => {
  it("accepts the answer each question type takes", () => {
    expect(validAnswer("RATING", 5, null)).toBe(true);
    expect(validAnswer("RATING", 0, null)).toBe(false);
    expect(validAnswer("ENPS", 0, null)).toBe(true);
    expect(validAnswer("ENPS", 11, null)).toBe(false);
    expect(validAnswer("YES_NO", 1, null)).toBe(true);
    expect(validAnswer("YES_NO", 2, null)).toBe(false);
    expect(validAnswer("TEXT", null, "  ")).toBe(false);
    expect(validAnswer("TEXT", null, "More staff on Fridays")).toBe(true);
  });

  it("works out eNPS from promoters and detractors", () => {
    expect(enps([10, 9, 8, 7, 6, 3])).toEqual({
      score: 0,
      promoters: 2,
      passives: 2,
      detractors: 2,
    });
    expect(enps([10, 10, 9, 8, 2]).score).toBe(40);
    expect(enps([]).score).toBeNull();
  });

  it("summarises ratings", () => {
    expect(ratingSummary([5, 4, 4, 2])).toEqual({ average: 3.75, counts: [0, 1, 0, 2, 1] });
    expect(ratingSummary([]).average).toBeNull();
  });

  it("hides results below five answers and keeps text out of answering order", () => {
    expect([mayShow(4), mayShow(5)]).toEqual([false, true]);
    const rows = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
    const once = shuffled(rows, "survey-1").map((r) => r.id);
    expect(shuffled(rows, "survey-1").map((r) => r.id)).toEqual(once); // stable
    expect(once.sort()).toEqual(["a", "b", "c", "d", "e"]);
  });
});
