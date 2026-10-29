import { describe, expect, it } from "vitest";
import { hasValidGs1CheckDigit, validateBarcode } from "./barcodes";

describe("barcodes", () => {
  it("validates GS1 check digits", () => {
    expect(hasValidGs1CheckDigit("4006381333931")).toBe(true); // EAN-13
    expect(hasValidGs1CheckDigit("4006381333932")).toBe(false);
    expect(hasValidGs1CheckDigit("036000291452")).toBe(true); // UPC-A
    expect(hasValidGs1CheckDigit("96385074")).toBe(true); // EAN-8
    expect(hasValidGs1CheckDigit("12a4")).toBe(false);
  });

  it("checks length and digits per symbology", () => {
    expect(validateBarcode("4006381333931", "EAN13")).toBeNull();
    expect(validateBarcode("400638133393", "EAN13")).toBe("invalidBarcode");
    expect(validateBarcode("4006381333932", "EAN13")).toBe("invalidCheckDigit");
    expect(validateBarcode("036000291452", "UPC_A")).toBeNull();
    expect(validateBarcode("96385074", "EAN8")).toBeNull();
  });

  it("accepts printable codes for free-form symbologies", () => {
    expect(validateBarcode("ABC-123/X", "CODE128")).toBeNull();
    expect(validateBarcode("with space", "INTERNAL")).toBe("invalidBarcode");
    expect(validateBarcode("", "QR")).toBe("invalidBarcode");
  });
});
