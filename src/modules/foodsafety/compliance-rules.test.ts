import { describe, expect, it } from "vitest";
import { complianceScore, scoreBand } from "./compliance-rules";

describe("compliance score (ADR-100)", () => {
  it("averages only the components that have data, with equal weights", () => {
    const r = complianceScore([
      { key: "RECORDS_IN_SPEC", passed: 9, counted: 10 },
      { key: "CHECKLIST_ITEMS_OK", passed: 0, counted: 0 },
      { key: "ACTIONS_ON_TIME", passed: 1, counted: 2 },
      { key: "EQUIPMENT_CALIBRATED", passed: 2, counted: 3 },
    ]);
    expect(r.components.map((c) => c.percent)).toEqual([90, null, 50, 67]);
    // (90 + 50 + 66.67) / 3 = 68.89 → 69
    expect(r.overall).toBe(69);
  });

  it("has no score without data", () => {
    const r = complianceScore([{ key: "RECORDS_IN_SPEC", passed: 0, counted: 0 }]);
    expect(r.overall).toBeNull();
    expect(scoreBand(r.overall)).toBe("NONE");
  });

  it("bands", () => {
    expect([scoreBand(90), scoreBand(89), scoreBand(75), scoreBand(74)]).toEqual([
      "GOOD",
      "FAIR",
      "FAIR",
      "POOR",
    ]);
  });
});
