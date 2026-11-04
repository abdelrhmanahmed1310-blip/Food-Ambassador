import { describe, expect, it } from "vitest";
import { classifyMenu } from "./menu-rules";

describe("menu engineering (ADR-107)", () => {
  // 4 items → equal share 25 %, popular from 17.5 %.
  const r = classifyMenu([
    { id: "burger", sold: "50", revenue: "2500", cost: "1000" }, // 50 a piece, margin 30
    { id: "fries", sold: "40", revenue: "600", cost: "120" }, // 15, margin 12
    { id: "steak", sold: "8", revenue: "1200", cost: "480" }, // 150, margin 90
    { id: "salad", sold: "2", revenue: "60", cost: "40" }, // 30, margin 10
    { id: "combo", sold: "10", revenue: "700", cost: null }, // no known cost
  ]);
  const by = (id: string) => r.items.find((i) => i.id === id)!;

  it("uses 70 % of an equal share and the weighted average margin", () => {
    expect(r.popularityThreshold?.toFixed(3)).toBe("0.175");
    // (1500 + 480 + 720 + 20) / 100 = 27.20
    expect(r.averageMargin?.toFixed(2)).toBe("27.20");
  });

  it("classifies stars, plowhorses, puzzles and dogs", () => {
    expect(["burger", "fries", "steak", "salad"].map((id) => by(id).menuClass)).toEqual([
      "STAR",
      "PLOWHORSE",
      "PUZZLE",
      "DOG",
    ]);
    expect([
      by("burger").mixShare?.toFixed(2),
      by("burger").unitMargin?.toFixed(2),
      by("burger").foodCost?.toFixed(2),
    ]).toEqual(["0.50", "30.00", "0.40"]);
  });

  it("leaves items without a cost out of the analysis", () => {
    expect([by("combo").menuClass, by("combo").mixShare, by("combo").unitMargin]).toEqual([
      null,
      null,
      null,
    ]);
    expect(by("combo").averagePrice?.toFixed()).toBe("70");
    expect(classifyMenu([]).popularityThreshold).toBeNull();
  });
});
