import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { pnlColumn, sumFigures } from "./pnl-rules";

describe("branch P&L rules (ADR-111)", () => {
  it("fills what did not happen with zero and gives each row as a share of sales", () => {
    const c = pnlColumn({
      SALES: new Decimal(1000),
      SALES_POS: new Decimal(800),
      SALES_B2B: new Decimal(200),
      COST_OF_SALES: new Decimal(320),
      STOCK_LOSSES: new Decimal(30),
      STAFF: new Decimal(250),
    });
    expect(
      [
        c.values.SALES_IMPORTED,
        c.values.GROSS_PROFIT,
        c.values.TOTAL_EXPENSES,
        c.values.OPERATING_RESULT,
      ].map((v) => v.toFixed()),
    ).toEqual(["0", "680", "250", "400"]);
    expect([c.shares.COST_OF_SALES?.toFixed(2), c.shares.OPERATING_RESULT?.toFixed(2)]).toEqual([
      "0.32",
      "0.40",
    ]);
    expect(c.values.UTILITIES.toFixed()).toBe("0");
  });

  it("has no margins without sales, and adds columns of one currency", () => {
    const empty = pnlColumn({ OCCUPANCY: new Decimal(500) });
    expect([empty.values.OPERATING_RESULT.toFixed(), empty.shares.OPERATING_RESULT]).toEqual([
      "-500",
      null,
    ]);
    const sum = sumFigures([
      { SALES: new Decimal(10), STOCK_LOSSES: new Decimal(-2) },
      { SALES: new Decimal(5), OCCUPANCY: new Decimal(1) },
    ]);
    expect([sum.SALES?.toFixed(), sum.STOCK_LOSSES?.toFixed(), sum.OCCUPANCY?.toFixed()]).toEqual([
      "15",
      "-2",
      "1",
    ]);
  });
});
