import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { applyDiscounts, promotionFor, saleMoment, type PromotionRule } from "./discounts";

const d = (v: string) => new Decimal(v);
const promo = (over: Partial<PromotionRule> = {}): PromotionRule => ({
  id: "p",
  name: "Lunch",
  percent: d("20"),
  categoryIds: ["mains"],
  itemIds: [],
  channels: [],
  weekdays: [],
  startTime: null,
  endTime: null,
  validFrom: "2026-11-01",
  validTo: null,
  ...over,
});
const at = { channel: "DINE_IN", date: "2026-11-02", time: "13:30:00", weekday: 1 };

describe("promotions (ADR-067)", () => {
  it("applies by item or category, channel, weekday, dates and hours", () => {
    const burger = { id: "burger", categoryId: "mains" };
    expect(promotionFor(burger, at, [promo()])?.id).toBe("p");
    expect(promotionFor({ id: "cola", categoryId: "drinks" }, at, [promo()])).toBeNull();
    expect(
      promotionFor({ id: "cola", categoryId: "drinks" }, at, [promo({ itemIds: ["cola"] })]),
    ).not.toBeNull();
    expect(promotionFor(burger, at, [promo({ channels: ["DELIVERY"] })])).toBeNull();
    expect(promotionFor(burger, at, [promo({ weekdays: [5, 6] })])).toBeNull();
    expect(promotionFor(burger, at, [promo({ validFrom: "2026-11-03" })])).toBeNull();
    expect(promotionFor(burger, at, [promo({ validTo: "2026-11-01" })])).toBeNull();
    expect(
      promotionFor(burger, at, [promo({ startTime: "12:00", endTime: "15:00" })]),
    ).not.toBeNull();
    expect(promotionFor(burger, at, [promo({ startTime: "17:00", endTime: "19:00" })])).toBeNull();
    // A window across midnight.
    expect(
      promotionFor(burger, { ...at, time: "23:30:00" }, [
        promo({ startTime: "22:00", endTime: "02:00" }),
      ]),
    ).not.toBeNull();
    expect(
      promotionFor(burger, { ...at, time: "01:59:00" }, [
        promo({ startTime: "22:00", endTime: "02:00" }),
      ]),
    ).not.toBeNull();
    expect(
      promotionFor(burger, { ...at, time: "02:00:00" }, [
        promo({ startTime: "22:00", endTime: "02:00" }),
      ]),
    ).toBeNull();
    // The best one wins.
    expect(promotionFor(burger, at, [promo(), promo({ id: "q", percent: d("30") })])?.id).toBe("q");
  });
});

describe("discounts and VAT", () => {
  const line = (gross: string, promoPercent: string | null = null) => ({
    gross: d(gross),
    rate: d("0.15"),
    promoPercent: promoPercent ? d(promoPercent) : null,
  });
  it("takes VAT out of the discounted amount", () => {
    const r = applyDiscounts([line("115", "20")], null, "SAR");
    expect(r.lines[0]).toMatchObject({
      discount: d("23"),
      gross: d("92"),
      net: d("80"),
      tax: d("12"),
    });
    expect(r.promoDiscount.toFixed()).toBe("23");
  });
  it("spreads an order discount over the lines to the halala", () => {
    const r = applyDiscounts(
      [line("100"), line("50"), line("0.01")],
      { kind: "PERCENT", value: d("10") },
      "SAR",
    );
    expect(r.orderDiscount.toFixed()).toBe("15");
    expect(r.lines.map((l) => l.discount.toFixed(2))).toEqual(["10.00", "5.00", "0.00"]);
    const total = r.lines.reduce((a, l) => a.plus(l.gross), d("0"));
    expect(total.toFixed(2)).toBe("135.01");
    const thirds = applyDiscounts(
      [line("10"), line("10"), line("10")],
      { kind: "AMOUNT", value: d("10") },
      "SAR",
    );
    expect(thirds.lines.map((l) => l.discount.toFixed(2))).toEqual(["3.33", "3.33", "3.34"]);
    for (const l of thirds.lines) expect(l.net.plus(l.tax).toFixed(2)).toBe(l.gross.toFixed(2));
  });
  it("applies the order discount after promotions and never below zero", () => {
    const r = applyDiscounts(
      [line("100", "50"), line("20")],
      { kind: "AMOUNT", value: d("500") },
      "SAR",
    );
    expect(r.orderDiscount.toFixed()).toBe("70"); // capped at what is left
    expect(r.lines.map((l) => l.gross.toFixed(2))).toEqual(["0.00", "0.00"]);
    const none = applyDiscounts(
      [{ gross: d("10"), rate: null, promoPercent: null }],
      { kind: "PERCENT", value: d("150") },
      "EGP",
    );
    expect(none.lines[0]).toMatchObject({ gross: d("0"), tax: d("0") });
  });

  it("reads the local date, time and weekday at the branch", () => {
    // 2026-11-01T22:30Z is Monday 01:30 in Riyadh (UTC+3) — after midnight local time.
    expect(saleMoment("DINE_IN", "Asia/Riyadh", new Date("2026-11-01T22:30:00Z"))).toEqual({
      channel: "DINE_IN",
      date: "2026-11-02",
      time: "01:30",
      weekday: 1,
    });
  });
});
