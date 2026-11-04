import { describe, expect, it } from "vitest";
import { expenseGross, totalsByGroup } from "./expense-rules";

describe("expense rules (ADR-109)", () => {
  it("adds VAT to net as entered", () => {
    expect(expenseGross("1000", "150").toFixed(2)).toBe("1150.00");
    expect(expenseGross("99.99", "0").toFixed(2)).toBe("99.99");
  });

  it("totals posted expenses per P&L group, reversals left out", () => {
    expect(
      totalsByGroup([
        { group: "UTILITIES", net: "300", status: "POSTED" },
        { group: "OCCUPANCY", net: "5000", status: "POSTED" },
        { group: "UTILITIES", net: "120.50", status: "POSTED" },
        { group: "MARKETING", net: "800", status: "REVERSED" },
      ]).map((g) => [g.group, g.net.toFixed(2)]),
    ).toEqual([
      ["OCCUPANCY", "5000.00"],
      ["UTILITIES", "420.50"],
    ]);
  });
});
