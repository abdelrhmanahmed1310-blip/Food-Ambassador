import { describe, expect, it } from "vitest";
import { allowedMoves, erasureDue, scorecardSummary, titleKey, workforceRows } from "./rules";

describe("application stages (ADR-129)", () => {
  it("move forward one step or out; hiring is not a move", () => {
    expect(allowedMoves("APPLIED")).toEqual(["SCREENING", "REJECTED", "WITHDRAWN"]);
    expect(allowedMoves("OFFER")).not.toContain("HIRED");
    expect(allowedMoves("REJECTED")).toEqual([]);
  });
});

describe("scorecards (ADR-129)", () => {
  it("average the ratings given, ignoring interviews not scored", () => {
    expect(
      scorecardSummary([
        { rating: 4, recommendation: "HIRE" },
        { rating: 3, recommendation: "UNSURE" },
        { rating: null, recommendation: null },
      ]),
    ).toEqual({ count: 2, average: 3.5, hire: 1, noHire: 0, unsure: 1 });
    expect(scorecardSummary([]).average).toBeNull();
  });
});

describe("workforce plan (ADR-129)", () => {
  it("compares planned positions with people in post and openings", () => {
    expect(titleKey("  Line   Cook ")).toBe("line cook");
    const rows = workforceRows({
      positions: [
        { branchId: "A", jobTitle: "Line cook", planned: 4 },
        { branchId: "A", jobTitle: "Cashier", planned: 2 },
      ],
      employees: [
        { branchId: "A", jobTitle: "line cook" },
        { branchId: "A", jobTitle: "Line Cook" },
        { branchId: "A", jobTitle: "Cashier" },
        { branchId: "A", jobTitle: "Cashier" },
        { branchId: "A", jobTitle: "Cashier" },
        { branchId: "A", jobTitle: "Driver" },
      ],
      openings: [{ branchId: "A", jobTitle: "Line cook", remaining: 1 }],
    });
    expect(rows.map((r) => [r.jobTitle, r.planned, r.filled, r.inRecruitment, r.gap])).toEqual([
      ["Cashier", 2, 3, 0, -1],
      ["Driver", 0, 1, 0, -1],
      ["Line cook", 4, 2, 1, 1],
    ]);
  });
});

describe("candidate retention (ADR-129)", () => {
  const now = new Date("2026-11-05T00:00:00Z");
  const old = new Date("2026-05-01T00:00:00Z");
  it("erases only closed candidates untouched beyond the entered days", () => {
    expect(erasureDue({ stages: ["REJECTED"], lastActivityAt: old, retentionDays: 180, now })).toBe(
      true,
    );
    expect(
      erasureDue({
        stages: ["REJECTED", "INTERVIEW"],
        lastActivityAt: old,
        retentionDays: 180,
        now,
      }),
    ).toBe(false);
    expect(erasureDue({ stages: [], lastActivityAt: old, retentionDays: 365, now })).toBe(false);
    expect(
      erasureDue({ stages: ["REJECTED"], lastActivityAt: old, retentionDays: null, now }),
    ).toBe(false);
  });
});
