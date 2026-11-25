import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  actionsWithinLimits,
  AUTONOMY_FOR,
  creditRequest,
  readSettings,
  targetPrice,
} from "./rules";

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
  it("falls back to defaults; drafts are replenishment's, and acting is not for invoices", () => {
    expect(readSettings("INVOICE_MATCHING", { minCreditAmount: "abc" })).toEqual({
      minCreditAmount: "0",
      uninvoicedAfterDays: 14,
    });
    expect(readSettings("FOOD_SAFETY", {})).toEqual({
      branchIds: [],
      complianceBelowPercent: 80,
      expiringWithinDays: 2,
      maxActionsPerRun: 3,
      holdHours: 4,
    });
    expect(readSettings("MENU_MARGIN", { effectiveInDays: "3" })).toEqual({
      effectiveInDays: 3,
      maxIncreasePercent: 5,
      maxActionsPerRun: 3,
      holdHours: 24,
    });
    expect(AUTONOMY_FOR.REPLENISHMENT).toEqual(["SUGGEST", "DRAFT", "ACT"]);
    expect(AUTONOMY_FOR.MENU_MARGIN).toEqual(["SUGGEST", "ACT"]);
    // Accepting supplier differences stays a person's decision.
    expect(AUTONOMY_FOR.INVOICE_MATCHING).toEqual(["SUGGEST"]);
  });
});

describe("actionsWithinLimits (ADR-145)", () => {
  const po = (index: number, total: string, currency = "SAR") => ({
    index,
    kind: "PURCHASE_ORDER",
    detail: { total, currency },
  });
  it("keeps orders within the per-order and the 24-hour amounts, in the organization's currency", () => {
    const settings = readSettings("REPLENISHMENT", {
      maxOrderAmount: "1000",
      maxDailyAmount: "1500",
    });
    const ctx = { baseCurrency: "SAR", actedToday: d("200") };
    expect(
      actionsWithinLimits(
        "REPLENISHMENT",
        settings,
        [po(0, "900"), po(1, "1200"), po(2, "500"), po(3, "300"), po(4, "100", "USD")],
        ctx,
      ),
    ).toEqual([0, 3]);
    expect(
      actionsWithinLimits("REPLENISHMENT", readSettings("REPLENISHMENT", {}), [po(0, "1")], ctx),
    ).toEqual([]);
  });

  it("caps non-conformances and price rises per run", () => {
    const nc = (index: number) => ({ index, kind: "RAISE_NC", detail: {} });
    expect(
      actionsWithinLimits(
        "FOOD_SAFETY",
        readSettings("FOOD_SAFETY", { maxActionsPerRun: "2" }),
        [nc(0), nc(1), nc(2)],
        { baseCurrency: "SAR", actedToday: d("0") },
      ),
    ).toEqual([0, 1]);
    const price = (index: number, from: string, to: string) => ({
      index,
      kind: "PRICE_CHANGE",
      detail: { price: from, newPrice: to },
    });
    expect(
      actionsWithinLimits(
        "MENU_MARGIN",
        readSettings("MENU_MARGIN", { maxIncreasePercent: "5", maxActionsPerRun: "2" }),
        [
          price(0, "25", "26"),
          price(1, "25", "33.34"),
          price(2, "20", "21"),
          price(3, "10", "10.1"),
        ],
        { baseCurrency: "SAR", actedToday: d("0") },
      ),
    ).toEqual([0, 2]);
    expect(
      actionsWithinLimits("INVOICE_MATCHING", {}, [nc(0)], {
        baseCurrency: "SAR",
        actedToday: d("0"),
      }),
    ).toEqual([]);
  });
});
