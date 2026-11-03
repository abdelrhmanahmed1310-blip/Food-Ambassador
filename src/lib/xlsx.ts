import ExcelJS from "exceljs";
import { parseCsv } from "./csv";

/**
 * Excel export (DECISIONS.md ADR-089): the same rows as the CSV export, as
 * an .xlsx workbook — so the two formats can never disagree. Numbers become
 * numbers (sums work in Excel) except in identifier columns (codes, SKUs,
 * numbers, references, phones, VAT and account numbers) and values that
 * would lose meaning as a number (leading zeros, more than 15 digits).
 */

const IDENTIFIER =
  /(^|_)(code|sku|number|no|ref|reference|phone|vat|tax|id|account|barcode|lot|entry)(_|$)/i;
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Whether a CSV cell becomes a number in the workbook. */
export function isNumericCell(header: string, value: string): boolean {
  if (IDENTIFIER.test(header)) return false;
  if (!NUMBER.test(value)) return false;
  return value.replace(/[-.]/g, "").length <= 15;
}

export async function csvToXlsx(csv: string, sheetName = "Export"): Promise<Uint8Array> {
  const [headers = [], ...rows] = parseCsv(csv.replace(/^﻿/, ""));
  const book = new ExcelJS.Workbook();
  book.creator = "Food Ambassador";
  const sheet = book.addWorksheet(sheetName.slice(0, 31));
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) {
    if (row.length === 1 && row[0] === "") continue;
    sheet.addRow(row.map((v, i) => (isNumericCell(headers[i] ?? "", v) ? Number(v) : v)));
  }
  headers.forEach((h, i) => {
    const longest = Math.max(h.length, ...rows.slice(0, 500).map((r) => (r[i] ?? "").length));
    sheet.getColumn(i + 1).width = Math.min(Math.max(longest + 2, 8), 60);
  });
  return new Uint8Array(await book.xlsx.writeBuffer());
}
