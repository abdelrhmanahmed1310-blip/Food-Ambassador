import { describe, expect, it } from "vitest";
import { countryCodes, isCountryCode } from "@/lib/countries";
import {
  daysLate,
  formatHsCode,
  isValidContainerNumber,
  isValidHsCode,
  normalizeHsCode,
} from "./rules";

describe("import shipment rules (ADR-113)", () => {
  it("checks ISO 6346 container numbers by their check digit", () => {
    expect(isValidContainerNumber("CSQU3054383")).toBe(true);
    expect(isValidContainerNumber("csqu 305438-3")).toBe(true);
    expect(isValidContainerNumber("CSQU3054384")).toBe(false);
    expect(isValidContainerNumber("MSKU1234565")).toBe(true);
    expect(isValidContainerNumber("CSQX3054383")).toBe(false);
  });

  it("keeps HS codes as digits and shows them grouped", () => {
    expect(normalizeHsCode("0402.21 10")).toBe("04022110");
    expect([isValidHsCode("040221"), isValidHsCode("0402"), isValidHsCode("04022110AB")]).toEqual([
      true,
      false,
      false,
    ]);
    expect(formatHsCode("04022110")).toBe("0402.21.10");
    expect(formatHsCode("040221")).toBe("0402.21");
  });

  it("counts days late only for shipments not yet arrived", () => {
    expect(daysLate({ status: "IN_TRANSIT", eta: "2026-11-01" }, "2026-11-04")).toBe(3);
    expect(daysLate({ status: "IN_TRANSIT", eta: "2026-11-04" }, "2026-11-04")).toBeNull();
    expect(daysLate({ status: "ARRIVED", eta: "2026-11-01" }, "2026-11-04")).toBeNull();
    expect(daysLate({ status: "PLANNED", eta: null }, "2026-11-04")).toBeNull();
  });

  it("knows the ISO countries from the runtime's data", () => {
    expect([
      isCountryCode("SA"),
      isCountryCode("EG"),
      isCountryCode("ZZ"),
      isCountryCode("EU"),
      isCountryCode("BU"),
    ]).toEqual([true, true, false, false, false]);
    expect(countryCodes().length).toBeGreaterThan(240);
  });
});
