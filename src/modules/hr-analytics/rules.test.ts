import { describe, expect, it } from "vitest";
import {
  absenceRate,
  daysStats,
  headcountOn,
  monthlySeries,
  monthsBetween,
  newHireRetention,
  overlapDays,
  rangeSummary,
  tenureBands,
} from "./rules";

const people = [
  { hireDate: "2024-01-10", terminatedOn: null },
  { hireDate: "2025-06-01", terminatedOn: "2026-02-14" },
  { hireDate: "2026-01-20", terminatedOn: null },
  { hireDate: "2026-02-01", terminatedOn: "2026-02-28" },
  { hireDate: "2026-03-05", terminatedOn: null },
];

describe("headcount and turnover (ADR-130)", () => {
  it("counts people employed on a day, the last day included", () => {
    expect(headcountOn(people, "2026-02-14")).toBe(4);
    expect(headcountOn(people, "2026-02-15")).toBe(3);
  });

  it("works out hires, leavers and turnover per month and over the range", () => {
    const rows = monthlySeries(people, monthsBetween("2026-01", "2026-03"));
    expect(rows.map((r) => [r.month, r.start, r.end, r.hires, r.leavers, r.turnover])).toEqual([
      ["2026-01", 2, 3, 1, 0, 0],
      ["2026-02", 4, 3, 1, 2, 57.1], // 2 ÷ 3.5 (the hire on the 1st counts at the start)
      ["2026-03", 2, 3, 1, 0, 0],
    ]);
    // Average headcount (2.5 + 3.5 + 2.5) ÷ 3 = 2.83; 2 leavers → 70.6 %.
    expect(rangeSummary(rows)).toMatchObject({
      hires: 3,
      leavers: 2,
      averageHeadcount: 2.8,
      turnover: 70.6,
    });
    expect(monthsBetween("2025-11", "2026-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
});

describe("tenure and retention (ADR-130)", () => {
  it("bands tenure of those employed", () => {
    expect(tenureBands(people, "2026-03-31")).toEqual({
      UNDER_3M: 2,
      "3_TO_12M": 0,
      "1_TO_3Y": 1,
      OVER_3Y: 0,
    });
  });

  it("keeps new hires still there on day 90, only once 90 days have passed", () => {
    // Hired Jan–Mar 2026: the one hired 2026-02-01 left within 90 days; March's is too recent.
    expect(newHireRetention(people, "2026-01-01", "2026-03-31", "2026-05-15")).toEqual({
      cohort: 2,
      kept: 1,
      rate: 50,
    });
  });
});

describe("days and absence (ADR-130)", () => {
  it("averages and takes the median", () => {
    expect(daysStats([10, 30, 20, 40])).toEqual({ count: 4, average: 25, median: 25 });
    expect(daysStats([]).average).toBeNull();
  });

  it("clips leave to the range and rates it against headcount", () => {
    expect(overlapDays("2026-01-28", "2026-02-03", "2026-02-01", "2026-02-28")).toBe(3);
    expect(overlapDays("2026-03-01", "2026-03-03", "2026-02-01", "2026-02-28")).toBe(0);
    // 14 days of leave over 10 people × 28 days = 5 %.
    expect(absenceRate(14, 10, 28)).toBe(5);
    expect(absenceRate(3, 0, 28)).toBeNull();
  });
});
