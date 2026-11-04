import { describe, expect, it } from "vitest";
import { ageBucket, ageInDays, daysOnHand, fifoAges, turnover } from "./stock-rules";

describe("stock rules (ADR-106)", () => {
  it("buckets ages", () => {
    expect([0, 30, 31, 60, 61, 90, 91, 180, 181, 900].map(ageBucket)).toEqual([
      "D0_30",
      "D0_30",
      "D31_60",
      "D31_60",
      "D61_90",
      "D61_90",
      "D91_180",
      "D91_180",
      "D181_PLUS",
      "D181_PLUS",
    ]);
    expect(ageInDays("2026-10-05", "2026-11-04")).toBe(30);
  });

  it("ages unlotted stock first in first out from its arrivals", () => {
    const ages = fifoAges(
      "15",
      [
        { date: "2026-08-01", quantity: "20" },
        { date: "2026-10-25", quantity: "10" },
      ],
      "2026-11-04",
    );
    expect(ages.map((a) => [a.ageDays, a.quantity.toFixed()])).toEqual([
      [10, "10"],
      [95, "5"],
    ]);
    // More on hand than recorded arrivals: the rest has no known age.
    expect(
      fifoAges("4", [{ date: "2026-11-01", quantity: "3" }], "2026-11-04").map((a) => a.ageDays),
    ).toEqual([3, null]);
  });

  it("turnover and days on hand need stock and usage", () => {
    // used 600, average stock (300 + 100) / 2 = 200 → 3 turns; 100 left at 20 a day → 5 days
    expect(turnover("600", "300", "100")?.toFixed()).toBe("3");
    expect(daysOnHand("100", "600", 30)?.toFixed()).toBe("5");
    expect(turnover("50", "0", "0")).toBeNull();
    expect(daysOnHand("100", "0", 30)).toBeNull();
  });
});
