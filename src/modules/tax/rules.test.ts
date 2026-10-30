import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { PRESETS } from "./presets";
import { currencyDecimals, rateOn, taxFromGross, taxFromNet, vatNumberProblem } from "./rules";

const d = (v: string) => new Decimal(v);

describe("VAT rules", () => {
  it("knows each currency's smallest unit", () => {
    expect([currencyDecimals("SAR"), currencyDecimals("AED"), currencyDecimals("EGP")]).toEqual([
      2, 2, 2,
    ]);
    expect([currencyDecimals("BHD"), currencyDecimals("KWD"), currencyDecimals("OMR")]).toEqual([
      3, 3, 3,
    ]);
  });

  it("applies the rate in effect on the sale date", () => {
    const sa = PRESETS.SA.standard.map((r) => ({
      rate: d(r.rate),
      effectiveFrom: r.effectiveFrom,
    }));
    expect(rateOn(sa, "2020-06-30")?.toFixed()).toBe("0.05");
    expect(rateOn(sa, "2020-07-01")?.toFixed()).toBe("0.15");
    expect(rateOn(sa, "2017-12-31")).toBeNull();
  });

  it("adds VAT to net amounts and splits inclusive ones, to the currency unit", () => {
    expect(taxFromNet(d("100"), d("0.15"), "SAR")).toEqual({
      net: d("100"),
      tax: d("15"),
      gross: d("115"),
    });
    const inc = taxFromGross(d("115"), d("0.15"), "SAR");
    expect([inc.net.toFixed(), inc.tax.toFixed()]).toEqual(["100", "15"]);
    // 10.00 incl. 14 % VAT: tax 1.2280… → 1.23, net 8.77.
    const eg = taxFromGross(d("10"), d("0.14"), "EGP");
    expect([eg.net.toFixed(), eg.tax.toFixed(), eg.gross.toFixed()]).toEqual([
      "8.77",
      "1.23",
      "10",
    ]);
    // Bahraini dinars round to fils (3 decimals).
    expect(taxFromNet(d("1.234"), d("0.1"), "BHD").tax.toFixed()).toBe("0.123");
    expect(taxFromNet(d("50"), d("0"), "AED").tax.toFixed()).toBe("0");
  });

  it("checks VAT number formats per country", () => {
    expect(vatNumberProblem("SA", "310122393500003")).toBeNull();
    expect(vatNumberProblem("SA", "300000000000004")).toBe("invalidVatNumber");
    expect(vatNumberProblem("SA", "31012239350003")).toBe("invalidVatNumber");
    expect(vatNumberProblem("AE", "100 2345 6789 0003")).toBeNull();
    expect(vatNumberProblem("BH", "12345")).toBe("invalidVatNumber");
    expect(vatNumberProblem("EG", "123-456-789")).toBeNull();
    expect(vatNumberProblem("EG", "1234567890")).toBe("invalidVatNumber");
  });

  it("ships presets only where VAT is in force", () => {
    expect(PRESETS.QA.standard).toEqual([]);
    expect(PRESETS.KW.vatInForce).toBe(false);
    expect(PRESETS.BH.standard.at(-1)).toEqual({ rate: "0.10", effectiveFrom: "2022-01-01" });
    expect(PRESETS.EG.standard.at(-1)?.rate).toBe("0.14");
  });
});
