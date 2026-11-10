import { describe, expect, it } from "vitest";
import { matchBarcode } from "./barcode-match";

const items = [
  { id: "water", barcodes: ["6281000000017"] },
  { id: "chips", barcodes: ["012345678905"] },
  { id: "sandwich", barcodes: ["SAND-01"] },
  { id: "none", barcodes: [] },
];

describe("matchBarcode (ADR-133)", () => {
  it("finds the item a code names, exactly", () => {
    expect(matchBarcode(items, "6281000000017")?.id).toBe("water");
    expect(matchBarcode(items, " SAND-01 ")?.id).toBe("sandwich");
  });
  it("matches UPC-A scanned as EAN-13 (leading zero), and the other way round", () => {
    expect(matchBarcode(items, "0012345678905")?.id).toBe("chips");
    expect(matchBarcode([{ id: "x", barcodes: ["0012345678905"] }], "012345678905")?.id).toBe("x");
  });
  it("finds nothing for unknown, empty or case-changed codes", () => {
    expect(matchBarcode(items, "9999999999994")).toBeNull();
    expect(matchBarcode(items, "")).toBeNull();
    expect(matchBarcode(items, "sand-01")).toBeNull();
  });
});
