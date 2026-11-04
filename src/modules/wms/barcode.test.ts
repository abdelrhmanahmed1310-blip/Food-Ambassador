import { describe, expect, it } from "vitest";
import {
  CODE128_PATTERNS,
  code128Bars,
  code128Values,
  encodable,
  matchesScan,
  normalizeScan,
} from "./barcode";

describe("Code 128 B (ADR-104)", () => {
  it("has a well-formed pattern table", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.forEach((p, i) => {
      const modules = [...p].reduce((a, c) => a + Number(c), 0);
      expect(modules).toBe(i === 106 ? 13 : 11);
    });
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });

  it("computes the weighted modulo-103 checksum", () => {
    // PJJ123C: 104 + 48·1 + 42·2 + 42·3 + 17·4 + 18·5 + 19·6 + 35·7 = 879 ≡ 55 (mod 103)
    expect(code128Values("PJJ123C")).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
  });

  it("lays out bars with quiet zones", () => {
    const { bars, width } = code128Bars("A");
    // start + A + checksum = 3 × 11, stop 13, quiet zones 2 × 10
    expect(width).toBe(33 + 13 + 20);
    expect(bars[0]).toEqual([10, 2]);
    expect(bars.length).toBe(3 * 3 + 4);
  });

  it("accepts printable ASCII only", () => {
    expect(encodable("PKU-2026-000001")).toBe(true);
    expect(encodable("")).toBe(false);
    expect(encodable("لبن")).toBe(false);
    expect(() => code128Values("é")).toThrow();
  });

  it("cleans what scanners send", () => {
    expect(normalizeScan(" PKU-2026-000001\r\n")).toBe("PKU-2026-000001");
    expect(normalizeScan("\x1d0105012345678901\t")).toBe("0105012345678901");
  });
});

describe("scan matching (ADR-104)", () => {
  const line = {
    product: { id: "p", sku: "MILK", barcodes: ["6221234567890"] },
    lot: { lotCode: "M-1" },
  };
  it("matches a product barcode, its SKU in any case, or the lot code", () => {
    expect(matchesScan(line, "6221234567890\n")).toBe(true);
    expect(matchesScan(line, "milk")).toBe(true);
    expect(matchesScan(line, "M-1")).toBe(true);
    expect(matchesScan(line, "M-2")).toBe(false);
  });
});
