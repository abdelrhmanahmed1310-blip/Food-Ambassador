import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { csvToXlsx, isNumericCell } from "./xlsx";

describe("Excel export (ADR-089)", () => {
  it("keeps identifiers as text and amounts as numbers", () => {
    expect(isNumericCell("quantity", "12.5")).toBe(true);
    expect(isNumericCell("net_base", "-3.20")).toBe(true);
    expect(isNumericCell("sku", "1001")).toBe(false);
    expect(isNumericCell("supplier_vat_number", "300000000000003")).toBe(false);
    expect(isNumericCell("account", "2100")).toBe(false);
    expect(isNumericCell("quantity", "0050")).toBe(false); // leading zero
    expect(isNumericCell("value", "1234567890123456")).toBe(false); // too long for Excel
    expect(isNumericCell("name", "Olive oil")).toBe(false);
  });

  it("writes the same rows as the CSV, Arabic included", async () => {
    const csv = toCsv(
      ["sku", "name", "quantity", "value"],
      [
        ["0042", "زيت زيتون", "12.5", "100.00"],
        ["TAHINI", "Tahini, 1kg", "3", null],
      ],
    );
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await csvToXlsx(csv, "Stock")).buffer as ArrayBuffer);
    const sheet = book.getWorksheet("Stock")!;
    expect(sheet.getRow(1).values).toEqual([undefined, "sku", "name", "quantity", "value"]);
    expect(sheet.getRow(2).values).toEqual([undefined, "0042", "زيت زيتون", 12.5, 100]);
    expect(sheet.getRow(3).getCell(2).value).toBe("Tahini, 1kg");
    expect(sheet.rowCount).toBe(3);
  });
});
