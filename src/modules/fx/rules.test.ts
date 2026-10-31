import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { isDocumentCurrency, pickRate, realisedDifference, toBase, unitToBase } from "./rules";

const d = (v: string) => new Decimal(v);
const rates = [
  { rateDate: "2026-11-01", rate: d("48.5") },
  { rateDate: "2026-11-05", rate: d("49") },
];

describe("exchange rates (ADR-050)", () => {
  it("uses 1 for the base currency and the latest rate on or before the date", () => {
    expect(pickRate("EGP", "EGP", [], "2026-11-03")).toMatchObject({ ok: true, rate: d("1") });
    expect(pickRate("USD", "EGP", rates, "2026-11-04")).toMatchObject({
      ok: true,
      rateDate: "2026-11-01",
    });
    expect(pickRate("USD", "EGP", rates, "2026-11-05")).toMatchObject({ rateDate: "2026-11-05" });
    expect(pickRate("USD", "EGP", rates, "2026-10-31")).toEqual({ ok: false, reason: "NO_RATE" });
    expect(pickRate("USD", "EGP", rates, "2026-11-12")).toMatchObject({ ok: true }); // 7 days old
    expect(pickRate("USD", "EGP", rates, "2026-11-13")).toEqual({
      ok: false,
      reason: "STALE",
      latest: "2026-11-05",
    });
  });

  it("converts amounts to the base unit and unit prices to 6 decimals", () => {
    expect(toBase(d("100.25"), d("48.5"), 2).toFixed()).toBe("4862.13"); // 4862.125 → half up
    expect(toBase(d("10"), d("0.385"), 3).toFixed()).toBe("3.85");
    expect(unitToBase(d("1.2345"), d("48.5")).toFixed()).toBe("59.87325");
  });

  it("measures realised differences: positive is a loss, negative a gain", () => {
    expect(realisedDifference(d("100"), d("48.5"), d("49"), 2).toFixed()).toBe("50");
    expect(realisedDifference(d("100"), d("49"), d("48.5"), 2).toFixed()).toBe("-50");
    expect(realisedDifference(d("100"), d("1"), d("1"), 2).toFixed()).toBe("0");
  });

  it("allows the GCC currencies, USD, EUR, EGP and the base currency", () => {
    for (const c of ["USD", "EUR", "SAR", "EGP", "AED", "KWD", "QAR", "BHD", "OMR"])
      expect(isDocumentCurrency(c, "EGP")).toBe(true);
    expect(isDocumentCurrency("GBP", "EGP")).toBe(false);
    expect(isDocumentCurrency("GBP", "GBP")).toBe(true);
  });
});

describe("period-end revaluation (ADR-052)", () => {
  it("values the open balance at the closing rate and measures the difference", async () => {
    const { revalue } = await import("./rules");
    expect(revalue(d("100"), d("4850"), d("50"), 2)).toEqual({
      revaluedBase: d("5000"),
      differenceBase: d("150"),
    });
    expect(revalue(d("100"), d("4850"), d("48"), 2).differenceBase.toFixed()).toBe("-50");
    // A debit balance (unapplied payment) revalues the other way.
    expect(revalue(d("-10"), d("-485"), d("50"), 2).differenceBase.toFixed()).toBe("-15");
  });
});
