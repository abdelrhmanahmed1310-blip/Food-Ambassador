/**
 * Country VAT presets (DECISIONS.md ADR-037). Applying a preset creates the
 * organization's own tax codes and rates, which it can then change (new
 * rates with an effective date). Facts checked on 2026-11-02; sources in the
 * ADR. Qatar and Kuwait have no VAT in force, so their presets create none.
 */

export const TAX_COUNTRIES = ["SA", "AE", "BH", "OM", "QA", "KW", "EG"] as const;
export type TaxCountry = (typeof TAX_COUNTRIES)[number];

export interface PresetRate {
  rate: string;
  effectiveFrom: string;
}

export interface CountryPreset {
  country: TaxCountry;
  vatInForce: boolean;
  /** Standard rate history, oldest first. */
  standard: PresetRate[];
  source: string;
  /** Typical for consumer prices in the market; the organization decides. */
  pricesIncludeTaxDefault: boolean;
}

export const PRESETS: Record<TaxCountry, CountryPreset> = {
  SA: {
    country: "SA",
    vatInForce: true,
    standard: [
      { rate: "0.05", effectiveFrom: "2018-01-01" },
      { rate: "0.15", effectiveFrom: "2020-07-01" },
    ],
    source:
      "KSA VAT Law; rate 15 % from 2020-07-01 (Ministerial Decision, Official Gazette 2020-05-15)",
    pricesIncludeTaxDefault: true,
  },
  AE: {
    country: "AE",
    vatInForce: true,
    standard: [{ rate: "0.05", effectiveFrom: "2018-01-01" }],
    source: "UAE Federal Decree-Law No. 8 of 2017 on VAT",
    pricesIncludeTaxDefault: true,
  },
  BH: {
    country: "BH",
    vatInForce: true,
    standard: [
      { rate: "0.05", effectiveFrom: "2019-01-01" },
      { rate: "0.10", effectiveFrom: "2022-01-01" },
    ],
    source: "Bahrain VAT Law; rate 10 % from 2022-01-01 (amendment of December 2021)",
    pricesIncludeTaxDefault: true,
  },
  OM: {
    country: "OM",
    vatInForce: true,
    standard: [{ rate: "0.05", effectiveFrom: "2021-04-16" }],
    source: "Oman Royal Decree 121/2020 (VAT from 2021-04-16)",
    pricesIncludeTaxDefault: true,
  },
  QA: {
    country: "QA",
    vatInForce: false,
    standard: [],
    source: "No VAT in force (GCC agreement signed, not implemented)",
    pricesIncludeTaxDefault: false,
  },
  KW: {
    country: "KW",
    vatInForce: false,
    standard: [],
    source: "No VAT in force (GCC agreement signed, not implemented)",
    pricesIncludeTaxDefault: false,
  },
  EG: {
    country: "EG",
    vatInForce: true,
    standard: [{ rate: "0.14", effectiveFrom: "2017-07-01" }],
    source: "Egypt VAT Law No. 67 of 2016; 14 % from FY 2017/2018",
    pricesIncludeTaxDefault: true,
  },
};
