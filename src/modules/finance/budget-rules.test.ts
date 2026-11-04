import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { shareOfSales, variance, withDerived } from "./budget-rules";

describe("budget rules (ADR-110)", () => {
  it("derives gross profit, total expenses and the operating result", () => {
    const r = withDerived({
      SALES: new Decimal(100000),
      COST_OF_SALES: new Decimal(32000),
      OCCUPANCY: new Decimal(15000),
      STAFF: new Decimal(25000),
    });
    expect([
      r.GROSS_PROFIT?.toFixed(),
      r.TOTAL_EXPENSES?.toFixed(),
      r.OPERATING_RESULT?.toFixed(),
    ]).toEqual(["68000", "40000", "28000"]);
    expect(r.UTILITIES).toBeNull();
    expect(withDerived({}).OPERATING_RESULT).toBeNull();
  });

  it("takes stock losses off the operating result, not the gross profit (ADR-111)", () => {
    const r = withDerived({
      SALES: new Decimal(1000),
      COST_OF_SALES: new Decimal(300),
      STOCK_LOSSES: new Decimal(40),
      UTILITIES: new Decimal(100),
    });
    expect([r.GROSS_PROFIT?.toFixed(), r.OPERATING_RESULT?.toFixed()]).toEqual(["700", "560"]);
    expect(withDerived({ STOCK_LOSSES: new Decimal(5) }).OPERATING_RESULT?.toFixed()).toBe("-5");
    expect(shareOfSales(r.OPERATING_RESULT, r.SALES)?.toFixed(2)).toBe("0.56");
    expect(shareOfSales(new Decimal(1), new Decimal(0))).toBeNull();
    expect(variance("STOCK_LOSSES", "10", "20")!.favourable).toBe(false);
  });

  it("judges variances by the kind of row", () => {
    // Sales 5 % over budget is good; rent 10 % over budget is not.
    const sales = variance("SALES", "100000", "105000")!;
    expect([sales.difference.toFixed(), sales.share?.toFixed(2), sales.favourable]).toEqual([
      "5000",
      "0.05",
      true,
    ]);
    const rent = variance("OCCUPANCY", "15000", "16500")!;
    expect([rent.share?.toFixed(2), rent.favourable]).toEqual(["0.10", false]);
    expect(variance("COST_OF_SALES", "30000", "28000")!.favourable).toBe(true);
    // A loss budget: the share is against its size.
    expect(variance("OPERATING_RESULT", "-1000", "-500")!.share?.toFixed(2)).toBe("0.50");
    expect(variance("STAFF", null, "100")).toBeNull();
    expect(variance("STAFF", "0", "100")!.share).toBeNull();
  });
});
