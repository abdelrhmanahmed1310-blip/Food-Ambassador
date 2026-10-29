import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords, toCsv } from "./csv";

describe("CSV", () => {
  it("parses quoted fields with commas, quotes and newlines", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n"multi\nline",z\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["multi\nline", "z"],
    ]);
  });

  it("handles BOM, missing trailing newline and blank lines", () => {
    expect(parseCsv("﻿sku,name\n\nA1,Rice")).toEqual([
      ["sku", "name"],
      ["A1", "Rice"],
    ]);
  });

  it("rejects unterminated quotes", () => {
    expect(() => parseCsv('a,"b')).toThrow();
  });

  it("maps records by normalized header", () => {
    const { headers, records } = parseCsvRecords(" SKU , Name_AR \nRICE-1, أرز \nOIL-1");
    expect(headers).toEqual(["sku", "name_ar"]);
    expect(records).toEqual([
      { sku: "RICE-1", name_ar: "أرز" },
      { sku: "OIL-1", name_ar: "" },
    ]);
  });

  it("serializes with escaping, BOM and formula-injection protection", () => {
    const csv = toCsv(
      ["a", "b"],
      [
        ["x,y", '=HYPERLINK("evil")'],
        ["-5", null],
      ],
    );
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(csv).toContain("-5,");
    expect(parseCsv(csv.slice(1))[1]).toEqual(["x,y", `'=HYPERLINK("evil")`]);
  });
});
