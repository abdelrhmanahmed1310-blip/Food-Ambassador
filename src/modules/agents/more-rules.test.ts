import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { AUTONOMY_FOR, creditRequest, readSettings, targetPrice } from "./rules";

/** Pure rules of the invoice matching and menu & margin agents (ADR-142). */

const d = (v: string) => new Decimal(v);
const line = (over: Partial<Parameters<typeof creditRequest>[0][number]>) => ({
  lineNo: 1,
  sku: "FLOUR",
  match: "PRICE_VARIANCE",
  quantity: d("50"),
  quantityBase: d("50"),
  unitPrice: d("12"),
  orderedUnitPrice: d("10"),
  quantityVariance: d("0"),
  priceVariance: d("100"),
  ...over,
});

describe("creditRequest", () => {
  it("asks for price above the order and quantity beyond the receipt, in the line's unit", () => {
    const r = creditRequest([
      line({}),
      // 2 bags of 25 kg billed, 10 kg more than received: 0.4 bag at 300.
      line({
        lineNo: 2,
        sku: "SUGAR",
        match: "QUANTITY_VARIANCE",
        quantity: d("2"),
        quantityBase: d("50"),
        unitPrice: d("300"),
        quantityVariance: d("10"),
        priceVariance: d("0"),
      }),
    ]);
    expect(r.lines.map((l) => [l.lineNo, l.reason, l.amount.toFixed(2)])).toEqual([
      [1, "PRICE", "100.00"],
      [2, "QUANTITY", "120.00"],
    ]);
    expect(r.total.toFixed(2)).toBe("220.00");
  });

  it("never nets off a line billed below the order price", () => {
    const r = creditRequest([line({ priceVariance: d("-30") }), line({ lineNo: 2 })]);
    expect(r.total.toFixed(2)).toBe("100.00");
    expect(creditRequest([line({ priceVariance: d("-30") })]).total.isZero()).toBe(true);
  });
});

describe("targetPrice", () => {
  it("keeps a net price as it is and grosses up a price that includes VAT", () => {
    expect(
      targetPrice({
        suggestedNet: d("33.34"),
        entered: d("25"),
        net: d("25"),
        includesTax: false,
      }).toFixed(2),
    ).toBe("33.34");
    // 28.75 entered = 25 net at 15 %: 33.34 net becomes 38.35 entered (rounded up).
    expect(
      targetPrice({
        suggestedNet: d("33.34"),
        entered: d("28.75"),
        net: d("25"),
        includesTax: true,
      }).toFixed(2),
    ).toBe("38.35");
  });
});

describe("settings and autonomy", () => {
  it("falls back to defaults and offers drafts only to replenishment", () => {
    expect(readSettings("INVOICE_MATCHING", { minCreditAmount: "abc" })).toEqual({
      minCreditAmount: "0",
      uninvoicedAfterDays: 14,
    });
    expect(readSettings("FOOD_SAFETY", {})).toEqual({
      branchIds: [],
      complianceBelowPercent: 80,
      expiringWithinDays: 2,
    });
    expect(readSettings("MENU_MARGIN", { effectiveInDays: "3" })).toEqual({ effectiveInDays: 3 });
    expect(AUTONOMY_FOR.REPLENISHMENT).toContain("DRAFT");
    expect(AUTONOMY_FOR.MENU_MARGIN).toEqual(["SUGGEST"]);
  });
});
