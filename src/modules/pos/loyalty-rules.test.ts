import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  formatGiftCardCode,
  giftCardCode,
  normalizePhone,
  pointsEarned,
  pointsToReverse,
  pointsValue,
  readGiftCardCode,
} from "./loyalty-rules";

const d = (v: string) => new Decimal(v);

describe("loyalty (ADR-068)", () => {
  it("earns whole points on what was paid and values points in the currency", () => {
    expect(pointsEarned(d("57.5"), d("1"))).toBe(57);
    expect(pointsEarned(d("57.5"), d("0.1"))).toBe(5);
    expect(pointsEarned(d("0"), d("1"))).toBe(0);
    expect(pointsEarned(d("100"), d("0"))).toBe(0);
    expect(pointsValue(123, d("0.05"), "SAR").toFixed(2)).toBe("6.15");
  });

  it("takes back points with refunds, never more than earned", () => {
    // 100 points on 115; refunded in three parts.
    const gross = d("115");
    expect(pointsToReverse(100, gross, d("0"), d("40"))).toBe(34);
    expect(pointsToReverse(100, gross, d("40"), d("40"))).toBe(35);
    expect(pointsToReverse(100, gross, d("80"), d("35"))).toBe(31);
    expect(34 + 35 + 31).toBe(100);
    expect(pointsToReverse(0, gross, d("0"), d("115"))).toBe(0);
  });

  it("reads Saudi numbers typed locally and others with their country code", () => {
    expect(normalizePhone("050 123 4567")).toBe("+966501234567");
    expect(normalizePhone("501234567")).toBe("+966501234567");
    expect(normalizePhone("+20 100 123 4567")).toBe("+201001234567");
    expect(normalizePhone("00971501234567")).toBe("+971501234567");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
  });
});

describe("gift card codes", () => {
  it("adds a check digit that catches a mistyped digit", () => {
    const code = giftCardCode("123456789012345");
    expect(code).toHaveLength(16);
    expect(readGiftCardCode(formatGiftCardCode(code))).toBe(code);
    expect(formatGiftCardCode(code)).toMatch(/^\d{4} \d{4} \d{4} \d{4}$/);
    const typo = code.slice(0, 3) + String((Number(code[3]) + 1) % 10) + code.slice(4);
    expect(readGiftCardCode(typo)).toBeNull();
    expect(readGiftCardCode("1234")).toBeNull();
  });
});
