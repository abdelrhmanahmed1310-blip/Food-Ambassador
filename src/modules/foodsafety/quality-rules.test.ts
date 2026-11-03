import { describe, expect, it } from "vitest";
import { findingCounts, isFoodSafetyComplaint, ncSeverityForFinding } from "./quality-rules";

describe("audit findings (ADR-098)", () => {
  it("open a non-conformance above an observation", () => {
    expect(ncSeverityForFinding("OBSERVATION")).toBeNull();
    expect(ncSeverityForFinding("MINOR")).toBe("MEDIUM");
    expect(ncSeverityForFinding("MAJOR")).toBe("HIGH");
    expect(ncSeverityForFinding("CRITICAL")).toBe("CRITICAL");
  });
  it("are counted by severity", () => {
    expect(findingCounts(["MINOR", "OBSERVATION", "MINOR", "CRITICAL"])).toEqual([
      { severity: "CRITICAL", count: 1 },
      { severity: "MAJOR", count: 0 },
      { severity: "MINOR", count: 2 },
      { severity: "OBSERVATION", count: 1 },
    ]);
  });
});

describe("complaints (ADR-098)", () => {
  it("treat foreign objects, illness and allergens as food safety", () => {
    expect(
      ["FOREIGN_OBJECT", "ILLNESS", "ALLERGEN"].every((c) => isFoodSafetyComplaint(c as never)),
    ).toBe(true);
    expect(isFoodSafetyComplaint("SERVICE")).toBe(false);
    expect(isFoodSafetyComplaint("QUALITY")).toBe(false);
  });
});
