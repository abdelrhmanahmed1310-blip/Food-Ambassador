import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { dishEconomics, foodCostFraction, priceForTarget } from "./pricing";

const d = (v: string) => new Decimal(v);

describe("dish pricing", () => {
  it("computes food cost %, margin and the price for a target", () => {
    expect(foodCostFraction(d("4.25"), d("15")).toFixed()).toBe("0.2833");
    expect(() => foodCostFraction(d("1"), d("0"))).toThrow(RangeError);
    expect(priceForTarget(d("4.25"), d("0.3")).toFixed()).toBe("14.17");
    expect(priceForTarget(d("3"), d("0.3")).toFixed()).toBe("10");
    expect(() => priceForTarget(d("1"), d("1"))).toThrow(RangeError);
  });

  it("classifies dishes and never judges incomplete costs", () => {
    const base = { costPerPortion: d("4.25"), missingCount: 0, price: d("15"), target: d("0.3") };
    expect(dishEconomics(base)).toMatchObject({ status: "OK" });
    expect(dishEconomics(base).margin?.toFixed()).toBe("10.75");
    expect(dishEconomics({ ...base, price: d("12") }).status).toBe("ABOVE_TARGET");
    // Exactly at the target is within it.
    expect(dishEconomics({ ...base, costPerPortion: d("4.5") }).status).toBe("OK");
    const incomplete = dishEconomics({ ...base, missingCount: 1, price: d("5") });
    expect(incomplete.status).toBe("INCOMPLETE");
    expect(incomplete.suggested).toBeNull();
    expect(dishEconomics({ ...base, price: null })).toMatchObject({
      status: "NO_PRICE",
      margin: null,
    });
    expect(dishEconomics({ ...base, target: null })).toMatchObject({
      status: "NO_TARGET",
      suggested: null,
    });
  });
});
