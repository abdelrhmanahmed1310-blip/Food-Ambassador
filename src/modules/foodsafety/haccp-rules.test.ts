import { describe, expect, it } from "vitest";
import { checkpointWithinLimits, decide, planProblems, riskScore } from "./haccp-rules";

const none = { q1: null, q2: null, q3: null, q4: null };

describe("Codex decision tree (ADR-096)", () => {
  it("leaves hazards that are not significant to the prerequisite programmes", () => {
    expect(decide(false, none).result).toBe("PRP");
  });

  it("walks the questions in order", () => {
    expect(decide(true, none)).toEqual({ result: null, next: "q1", asked: [] });
    expect(decide(true, { ...none, q1: false }).result).toBe("MODIFY");
    expect(decide(true, { ...none, q1: true })).toMatchObject({ result: null, next: "q2" });
    // Cooking: designed to kill pathogens.
    expect(decide(true, { ...none, q1: true, q2: true }).result).toBe("CCP");
    expect(decide(true, { ...none, q1: true, q2: false, q3: false }).result).toBe("OPRP");
    expect(decide(true, { ...none, q1: true, q2: false, q3: true })).toMatchObject({
      result: null,
      next: "q4",
    });
    // Receiving chilled meat: a later cooking step controls it.
    expect(decide(true, { q1: true, q2: false, q3: true, q4: true }).result).toBe("OPRP");
    // Cooling after cooking: nothing later removes growth.
    expect(decide(true, { q1: true, q2: false, q3: true, q4: false }).result).toBe("CCP");
  });

  it("ignores answers to questions the tree does not reach", () => {
    expect(decide(true, { q1: true, q2: true, q3: false, q4: true }).asked).toEqual(["q1", "q2"]);
  });

  it("scores risk", () => {
    expect(riskScore(4, 5)).toBe(20);
  });
});

describe("planProblems", () => {
  const hazard = {
    id: "h1",
    significant: true,
    answers: { q1: true, q2: true, q3: null, q4: null },
    classification: "CCP" as const,
    hasControlPoint: true,
  };
  it("is ready with steps and controlled hazards", () => {
    expect(planProblems({ steps: 2, hazards: [hazard] })).toEqual([]);
  });
  it("names what is missing", () => {
    expect(planProblems({ steps: 0, hazards: [] }).map((p) => p.code)).toEqual([
      "NO_STEPS",
      "NO_HAZARDS",
    ]);
    expect(
      planProblems({
        steps: 1,
        hazards: [
          { ...hazard, hasControlPoint: false },
          { ...hazard, id: "h2", answers: { ...none, q1: false }, classification: "OPRP" },
          { ...hazard, id: "h3", answers: none, classification: "PRP", hasControlPoint: false },
        ],
      }),
    ).toEqual([
      { code: "CONTROL_POINT_MISSING", hazardId: "h1" },
      { code: "STEP_NEEDS_CONTROL", hazardId: "h2" },
      { code: "TREE_INCOMPLETE", hazardId: "h3" },
    ]);
  });
});

describe("checkpointWithinLimits", () => {
  it("needs the checkpoint's limits inside the critical limits", () => {
    // Chilled storage, critical limit ≤ 5 °C.
    expect(checkpointWithinLimits({ min: 0, max: 4 }, { min: null, max: 5 })).toBe(true);
    expect(checkpointWithinLimits({ min: 0, max: 8 }, { min: null, max: 5 })).toBe(false);
    expect(checkpointWithinLimits({ min: 0, max: null }, { min: null, max: 5 })).toBe(false);
    // Cooking, core ≥ 75 °C.
    expect(checkpointWithinLimits({ min: 75, max: null }, { min: 75, max: null })).toBe(true);
    expect(checkpointWithinLimits({ min: 70, max: null }, { min: 75, max: null })).toBe(false);
    expect(checkpointWithinLimits({ min: null, max: null }, { min: null, max: null })).toBe(true);
  });
});
