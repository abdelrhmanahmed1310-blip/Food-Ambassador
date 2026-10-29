import { describe, expect, it } from "vitest";
import {
  Decimal,
  allocateProportionally,
  decimalString,
  roundMoney,
  roundQuantity,
  sum,
  toDecimal,
} from "./decimal";

describe("toDecimal", () => {
  it("parses decimal strings exactly", () => {
    expect(toDecimal("0.1").plus(toDecimal("0.2")).toString()).toBe("0.3");
    expect(toDecimal(" 12.500 ").toFixed()).toBe("12.5");
    expect(toDecimal("-3.25").toString()).toBe("-3.25");
  });

  it("accepts safe integers and bigints", () => {
    expect(toDecimal(42).toString()).toBe("42");
    expect(toDecimal(10n ** 20n).toFixed()).toBe("100000000000000000000");
  });

  it("rejects fractional JS numbers, which may already carry float error", () => {
    expect(() => toDecimal(0.1)).toThrow(TypeError);
    expect(() => toDecimal(Number.NaN)).toThrow(TypeError);
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it("rejects malformed strings", () => {
    for (const bad of ["", "abc", "1e5", "1,000", "1.", ".5", "--1", "0x10"]) {
      expect(() => toDecimal(bad), bad).toThrow(TypeError);
    }
  });
});

describe("rounding", () => {
  it("rounds money half-up to 4 places", () => {
    expect(roundMoney("1.00005").toFixed()).toBe("1.0001");
    expect(roundMoney("1.00004").toFixed()).toBe("1");
    expect(roundMoney("-1.00005").toFixed()).toBe("-1.0001");
  });

  it("rounds quantities to 6 places", () => {
    expect(roundQuantity("2.1234565").toFixed()).toBe("2.123457");
  });
});

describe("sum", () => {
  it("adds without floating-point drift", () => {
    const tenths = Array.from({ length: 10 }, () => "0.1");
    expect(sum(tenths).toString()).toBe("1");
    expect(sum([]).toString()).toBe("0");
  });
});

describe("allocateProportionally", () => {
  it("allocates exactly and sums to the rounded total", () => {
    const shares = allocateProportionally("100", ["1", "1", "1"]);
    expect(sum(shares).toFixed()).toBe("100");
    expect(shares.map((s) => s.toFixed())).toEqual(["33.3334", "33.3333", "33.3333"]);
  });

  it("gives the rounding remainder to the largest weight", () => {
    const shares = allocateProportionally("10", ["1", "2"], 2);
    expect(shares.map((s) => s.toFixed())).toEqual(["3.33", "6.67"]);
  });

  it("supports zero weights alongside positive ones", () => {
    const shares = allocateProportionally("50", ["0", "5"]);
    expect(shares.map((s) => s.toFixed())).toEqual(["0", "50"]);
  });

  it("rejects invalid weights", () => {
    expect(() => allocateProportionally("1", [])).toThrow(RangeError);
    expect(() => allocateProportionally("1", ["0", "0"])).toThrow(RangeError);
    expect(() => allocateProportionally("1", ["-1", "2"])).toThrow(RangeError);
  });
});

describe("decimalString schema", () => {
  const quantity = decimalString({ maxScale: 6, min: "0" });

  it("normalizes valid input", () => {
    expect(quantity.parse(" 1.500000 ")).toBe("1.5");
  });

  it("rejects too many decimal places", () => {
    const r = quantity.safeParse("1.1234567");
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe("tooManyDecimals");
  });

  it("uses translation keys as messages", () => {
    expect(quantity.safeParse("abc").error?.issues[0].message).toBe("invalidDecimal");
    expect(quantity.safeParse("-1").error?.issues.map((i) => i.message)).toContain(
      "mustNotBeNegative",
    );
    expect(
      decimalString({ maxScale: 6, min: "0.000001" }).safeParse("0").error?.issues[0].message,
    ).toBe("mustBePositive");
  });

  it("enforces negative minimums and maximums", () => {
    const temperature = decimalString({ maxScale: 1, min: "-80", max: "80", allowNegative: true });
    expect(temperature.parse("-18.5")).toBe("-18.5");
    expect(temperature.safeParse("-81").error?.issues[0].message).toBe("belowMinimum");
    expect(temperature.safeParse("80.1").error?.issues[0].message).toBe("aboveMaximum");
    expect(decimalString({ maxScale: 2, min: "0", max: "100" }).parse("100")).toBe("100");
  });

  it("rejects negatives unless allowed", () => {
    expect(quantity.safeParse("-1").success).toBe(false);
    expect(decimalString({ maxScale: 2, allowNegative: true }).parse("-1.25")).toBe("-1.25");
  });

  it("enforces a minimum", () => {
    const positive = decimalString({ maxScale: 6, min: "0.000001" });
    expect(positive.safeParse("0").success).toBe(false);
    expect(positive.parse("0.000001")).toBe("0.000001");
  });

  it("rejects non-numeric strings", () => {
    expect(quantity.safeParse("ten").success).toBe(false);
    expect(quantity.safeParse("1e3").success).toBe(false);
  });

  it("produces values that round-trip through Decimal", () => {
    expect(new Decimal(quantity.parse("0003.140")).toFixed()).toBe("3.14");
  });
});
