import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { lastMonths, monthOf, monthRange, ratio, splitByPeriod } from "./rules";

describe("report rules", () => {
  it("shows a ratio only when net sales are known and not zero", () => {
    expect(ratio(new Decimal("30"), new Decimal("100"))?.toFixed()).toBe("0.3");
    expect(ratio(new Decimal("30"), new Decimal("0"))).toBeNull();
    expect(ratio(new Decimal("30"), null)).toBeNull();
  });

  it("counts an import in a period only when all its sales are inside", () => {
    const imports = [
      { id: "in", firstSale: "2026-10-02", lastSale: "2026-10-05" },
      { id: "edge", firstSale: "2026-10-31", lastSale: "2026-10-31" },
      { id: "across", firstSale: "2026-09-29", lastSale: "2026-10-01" },
      { id: "out", firstSale: "2026-11-01", lastSale: "2026-11-02" },
    ];
    const r = splitByPeriod(imports, "2026-10-01", "2026-10-31");
    expect(r.inside.map((i) => i.id)).toEqual(["in", "edge"]);
    expect(r.straddling.map((i) => i.id)).toEqual(["across"]);
    expect(monthOf(imports[0])).toBe("2026-10");
    expect(monthOf(imports[2])).toBeNull();
  });

  it("lists months and their ranges across a year end and leap February", () => {
    expect(lastMonths("2027-02-10", 4)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});
