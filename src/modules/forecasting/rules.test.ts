import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  backtest,
  forecast,
  forecastOrder,
  predict,
  weeklyTotals,
  type ForecastOrderInput,
} from "./rules";

const d = (values: number[]) => values.map((v) => new Decimal(v));
/** Weeks of a weekday pattern: Mon–Fri 10, weekend 30 (index 0 = a Monday). */
const weekly = (weeks: number) =>
  d(Array.from({ length: weeks * 7 }, (_, i) => (i % 7 >= 5 ? 30 : 10)));

describe("predict", () => {
  it("averages the last 7 or 28 days, or as many as there are", () => {
    const s = d([...Array(21).fill(2), ...Array(7).fill(9)]);
    expect(predict("MOVING_AVERAGE_7", s).toFixed()).toBe("9");
    expect(predict("MOVING_AVERAGE_28", s).toFixed(2)).toBe("3.75");
    expect(predict("MOVING_AVERAGE_28", d([4, 6])).toFixed()).toBe("5");
    expect(predict("MOVING_AVERAGE_7", []).toFixed()).toBe("0");
  });

  it("takes the same weekday of the last four weeks, for each day ahead", () => {
    const s = weekly(4); // ends on a Sunday; tomorrow is a Monday
    expect(predict("SAME_WEEKDAY", s, 0).toFixed()).toBe("10");
    expect(predict("SAME_WEEKDAY", s, 5).toFixed()).toBe("30"); // Saturday
    expect(predict("SAME_WEEKDAY", s, 12).toFixed()).toBe("30"); // Saturday next week
    expect(predict("SAME_WEEKDAY", s, 7).toFixed()).toBe("10");
    // Only two weeks of history: two Mondays.
    expect(
      predict("SAME_WEEKDAY", d([1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0]), 0).toFixed(),
    ).toBe("2");
  });
});

describe("backtest", () => {
  it("scores one-day-ahead forecasts over the last days", () => {
    const flat = d(Array(30).fill(5));
    const a = backtest("MOVING_AVERAGE_7", flat);
    expect([a.wape?.toFixed(), a.bias?.toFixed(), a.rmse.toFixed()]).toEqual(["0", "0", "0"]);
    const none = backtest("MOVING_AVERAGE_7", d(Array(30).fill(0)));
    expect([none.wape, none.bias]).toEqual([null, null]);
    // Demand doubles in the last 14 days: a 28-day average under-forecasts.
    const step = d([...Array(28).fill(10), ...Array(14).fill(20)]);
    const ma28 = backtest("MOVING_AVERAGE_28", step);
    expect(ma28.bias!.lt(0)).toBe(true);
    expect(backtest("MOVING_AVERAGE_7", step).wape!.lt(ma28.wape!)).toBe(true);
  });
});

describe("forecast", () => {
  it("gives none until the item has four weeks of history", () => {
    expect(forecast(weekly(3), 21)).toEqual({ status: "SHORT_HISTORY", historyDays: 21 });
  });

  it("chooses the method that would have been most accurate", () => {
    const f = forecast(weekly(8), 200, 7);
    expect(f.status).toBe("OK");
    if (f.status !== "OK") return;
    expect(f.method).toBe("SAME_WEEKDAY");
    expect(f.accuracy.wape?.toFixed()).toBe("0");
    expect(f.daily.map((x) => x.toFixed())).toEqual(["10", "10", "10", "10", "10", "30", "30"]);
    expect(f.scores.map((s) => s.method)).toEqual([
      "MOVING_AVERAGE_28",
      "MOVING_AVERAGE_7",
      "SAME_WEEKDAY",
    ]);
  });

  it("keeps the steadier method on a tie and uses only the item's own history", () => {
    const flat = d([...Array(26).fill(0), ...Array(30).fill(4)]);
    const f = forecast(flat, 30);
    if (f.status !== "OK") throw new Error("expected a forecast");
    expect(f.method).toBe("MOVING_AVERAGE_28");
    expect(f.daily[0].toFixed()).toBe("4");
  });
});

describe("forecastOrder", () => {
  const base: ForecastOrderInput = {
    daily: d(Array(7).fill(10)),
    rmse: new Decimal(0),
    leadTimeDays: 3,
    reviewDays: 7,
    serviceLevel: "0.95",
    availableBase: new Decimal(40),
    onOrderBase: new Decimal(0),
    basePerPurchaseUnit: new Decimal(12),
    minOrderPurchaseUnits: null,
  };

  it("orders forecast demand over lead time and review, less stock and orders", () => {
    const o = forecastOrder(base);
    // 10 days × 10 (the last forecast day carries on) − 40 = 60 → 5 cases of 12.
    expect([
      o.coverDays,
      o.demandBase.toFixed(),
      o.purchaseUnits?.toFixed(),
      o.base?.toFixed(),
    ]).toEqual([10, "100", "5", "60"]);
    expect(forecastOrder({ ...base, onOrderBase: new Decimal(60) }).purchaseUnits).toBeNull();
    expect(
      forecastOrder({ ...base, minOrderPurchaseUnits: new Decimal(8) }).purchaseUnits?.toFixed(),
    ).toBe("8");
  });

  it("adds safety stock from the forecast error at the service level", () => {
    const o = forecastOrder({ ...base, rmse: new Decimal(2), leadTimeDays: 2, reviewDays: 2 });
    // 1.6449 × 2 × √4 = 6.5796
    expect([o.safetyBase.toFixed(), o.targetBase.toFixed()]).toEqual(["6.5796", "46.5796"]);
    expect(o.purchaseUnits?.toFixed()).toBe("1");
    expect(() => forecastOrder({ ...base, reviewDays: 0 })).toThrow(RangeError);
  });
});

describe("weeklyTotals", () => {
  it("adds up whole weeks back from the last day", () => {
    expect(weeklyTotals(d([1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 5])).map(String)).toEqual([
      "1",
      "8",
      "17",
    ]);
  });
});
