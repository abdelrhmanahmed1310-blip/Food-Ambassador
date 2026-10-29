import { describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import { compatibleUnits, conversionFactor, toBaseQuantity, type UnitDef } from "./units";

const g: UnitDef = { id: "g", code: "g", dimension: "MASS", factorToBase: "1" };
const kg: UnitDef = { id: "kg", code: "kg", dimension: "MASS", factorToBase: "1000" };
const lb: UnitDef = { id: "lb", code: "lb", dimension: "MASS", factorToBase: "453.59237" };
const ml: UnitDef = { id: "ml", code: "ml", dimension: "VOLUME", factorToBase: "1" };
const l: UnitDef = { id: "l", code: "l", dimension: "VOLUME", factorToBase: "1000" };
const each: UnitDef = { id: "each", code: "each", dimension: "COUNT", factorToBase: "1" };
const dozen: UnitDef = { id: "dozen", code: "dozen", dimension: "COUNT", factorToBase: "12" };
const caseU: UnitDef = { id: "case", code: "case", dimension: "COUNT", factorToBase: null };

describe("unit conversion", () => {
  it("converts within a dimension exactly", () => {
    expect(toBaseQuantity("2.5", kg, g, []).toFixed()).toBe("2500");
    expect(toBaseQuantity("750", g, kg, []).toFixed()).toBe("0.75");
    expect(toBaseQuantity("1", lb, kg, []).toFixed()).toBe("0.453592");
    expect(toBaseQuantity("3", dozen, each, []).toFixed()).toBe("36");
    expect(toBaseQuantity("0.333", l, ml, []).toFixed()).toBe("333");
  });

  it("returns 1 for the base unit itself", () => {
    expect(conversionFactor(kg, kg, []).toFixed()).toBe("1");
  });

  it("rejects cross-dimension conversion without a product-specific factor", () => {
    expect(() => toBaseQuantity("1", l, kg, [])).toThrow(AppError);
    try {
      toBaseQuantity("1", l, kg, []);
    } catch (e) {
      expect((e as AppError).details).toMatchObject({
        rule: "INCOMPATIBLE_UNITS",
        from: "l",
        to: "kg",
      });
    }
  });

  it("rejects packaging units without a product-specific factor", () => {
    expect(() => toBaseQuantity("1", caseU, each, [])).toThrow(AppError);
  });

  it("uses product-specific conversions for packaging and cross-dimension units", () => {
    expect(
      toBaseQuantity("2", caseU, each, [{ uomId: "case", factorToBase: "24" }]).toFixed(),
    ).toBe("48");
    // Eggs counted in each, product says 1 each = 60 g: entering grams is NOT implied by that.
    expect(() => toBaseQuantity("60", g, each, [])).toThrow(AppError);
    // Product base kg, sold by the each at 0.25 kg each.
    expect(toBaseQuantity("4", each, kg, [{ uomId: "each", factorToBase: "0.25" }]).toFixed()).toBe(
      "1",
    );
  });

  it("product-specific factor overrides the generic ratio", () => {
    expect(
      toBaseQuantity("1", dozen, each, [{ uomId: "dozen", factorToBase: "10" }]).toFixed(),
    ).toBe("10");
  });

  it("rounds to 6 decimal places half-up", () => {
    const third: UnitDef = { id: "t", code: "t", dimension: "MASS", factorToBase: "0.3333333333" };
    expect(toBaseQuantity("1", third, g, []).toFixed()).toBe("0.333333");
  });

  it("lists compatible units for a product", () => {
    const units = [g, kg, lb, ml, l, each, dozen, caseU];
    expect(compatibleUnits(units, kg, []).map((u) => u.code)).toEqual(["g", "kg", "lb"]);
    expect(
      compatibleUnits(units, each, [{ uomId: "case", factorToBase: "6" }]).map((u) => u.code),
    ).toEqual(["each", "dozen", "case"]);
  });
});
