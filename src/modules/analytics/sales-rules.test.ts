import { describe, expect, it } from "vitest";
import {
  averageTicket,
  daysBetween,
  growth,
  isoWeekday,
  monthsCovering,
  proratedTarget,
  samePeriodLastYear,
} from "./sales-rules";

describe("sales rules (ADR-105)", () => {
  it("growth needs a base", () => {
    expect(growth("120", "100")?.toFixed(2)).toBe("0.20");
    expect(growth("80", "100")?.toFixed(2)).toBe("-0.20");
    expect(growth("50", "0")).toBeNull();
    expect(averageTicket("100", 0)).toBeNull();
    expect(averageTicket("100", 4)?.toFixed()).toBe("25");
  });

  it("compares with the same dates last year", () => {
    expect(samePeriodLastYear("2026-11-01", "2026-11-30")).toEqual({
      from: "2025-11-01",
      to: "2025-11-30",
    });
    expect(samePeriodLastYear("2028-02-29", "2028-02-29")).toEqual({
      from: "2027-02-28",
      to: "2027-02-28",
    });
  });

  it("spreads monthly targets over the period's days", () => {
    const targets = [
      { month: "2026-11-01", amount: "30000" },
      { month: "2026-12-01", amount: "31000" },
    ];
    // 1–10 November: 10/30 of 30 000
    expect(proratedTarget(targets, "2026-11-01", "2026-11-10")?.toFixed(2)).toBe("10000.00");
    // 21 Nov – 5 Dec: 10/30 × 30 000 + 5/31 × 31 000
    expect(proratedTarget(targets, "2026-11-21", "2026-12-05")?.toFixed(2)).toBe("15000.00");
    expect(proratedTarget(targets, "2027-01-01", "2027-01-31")).toBeNull();
  });

  it("knows weekdays, lengths and months", () => {
    expect(isoWeekday("2026-11-04")).toBe(3); // Wednesday
    expect(isoWeekday("2026-11-08")).toBe(7);
    expect(daysBetween("2026-11-01", "2026-11-30")).toBe(30);
    expect(monthsCovering("2026-11-15", "2027-01-02")).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
    ]);
  });
});
