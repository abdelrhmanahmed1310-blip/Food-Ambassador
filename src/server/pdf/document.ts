import "server-only";
import path from "node:path";
import PDFDocument from "pdfkit";

/**
 * Printable PDF documents (DECISIONS.md ADR-089), made on the server with
 * pdfkit and the bundled DejaVu Sans fonts (which cover Arabic; pdfkit
 * shapes Arabic letters and orders right-to-left words itself). One layout
 * for every document: seller, title and number, the other party, details,
 * a table of lines, totals, notes and page numbers.
 *
 * Arabic and numbers are never mixed in one string: a label and its value
 * are separate cells (pdfkit misplaces punctuation and spaces when they
 * share a line), and spaces between Arabic words are kept as no-break
 * spaces, which pdfkit otherwise drops.
 */

export interface PdfColumn {
  label: string;
  /** Share of the table width. */
  width: number;
  align?: "left" | "right";
}

export interface PdfDocumentInput {
  title: string;
  number: string;
  /** The issuing company: legal name, address lines, and labelled facts (VAT and CR numbers). */
  seller: { name: string; lines: string[]; facts?: Array<[string, string]> };
  /** The other party (supplier, customer), with a label such as "Supplier". */
  party?: { label: string; name: string; lines: string[]; facts?: Array<[string, string]> };
  /** Key facts: dates, currency, warehouse… */
  details: Array<[string, string]>;
  columns: PdfColumn[];
  rows: string[][];
  totals: Array<[string, string]>;
  notes?: string[];
}

/** Keep spaces between Arabic words (pdfkit drops plain ones in right-to-left runs). */
export function keepArabicSpaces(text: string): string {
  return text.replace(/(?<=[\u0600-\u06FF]) +(?=[\u0600-\u06FF])/g, "\u00a0");
}

const FONTS = path.join(process.cwd(), "assets", "fonts");
const MARGIN = 40;
const GREY = "#555555";
const LINE = "#d0d0d0";

export async function renderPdf(input: PdfDocumentInput): Promise<Uint8Array> {
  const doc = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    bufferPages: true,
    info: { Title: `${input.title} ${input.number}` },
  });
  doc.registerFont("regular", path.join(FONTS, "DejaVuSans.ttf"));
  doc.registerFont("bold", path.join(FONTS, "DejaVuSans-Bold.ttf"));
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));

  // Every string goes through keepArabicSpaces.
  const text = (value: string, ...rest: unknown[]) =>
    (doc.text as (...a: unknown[]) => PDFKit.PDFDocument)(keepArabicSpaces(value), ...rest);
  const width = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - MARGIN - 30;
  /** Label and value as two cells on one row. */
  const facts = (rows: Array<[string, string]>, left: number, w: number) => {
    for (const [label, value] of rows) {
      const fy = doc.y;
      doc.font("regular").fontSize(8.5).fillColor(GREY);
      text(label, left, fy, { width: w * 0.45 });
      const end = doc.y;
      text(value, left + w * 0.45, fy, { width: w * 0.55 });
      doc.y = Math.max(end, doc.y);
    }
    doc.fillColor("black");
  };

  // Header: seller on the left, title and number on the right.
  const top = doc.y;
  doc
    .font("bold")
    .fontSize(13)
    .text(input.seller.name, MARGIN, top, { width: width * 0.6 });
  doc.font("regular").fontSize(8.5).fillColor(GREY);
  for (const l of input.seller.lines) text(l, { width: width * 0.6 });
  facts(input.seller.facts ?? [], MARGIN, width * 0.6);
  const leftEnd = doc.y;
  doc
    .fillColor("black")
    .font("bold")
    .fontSize(16)
    .text(input.title, MARGIN, top, { width, align: "right" });
  doc.font("regular").fontSize(11).text(input.number, { width, align: "right" });
  doc.y = Math.max(leftEnd, doc.y) + 14;

  // Party and details side by side.
  const blockTop = doc.y;
  if (input.party) {
    doc
      .font("bold")
      .fontSize(9)
      .fillColor(GREY)
      .text(input.party.label.toUpperCase(), MARGIN, blockTop, { width: width / 2 - 10 });
    doc
      .fillColor("black")
      .font("bold")
      .fontSize(10.5)
      .text(input.party.name, { width: width / 2 - 10 });
    doc.font("regular").fontSize(9);
    for (const l of input.party.lines) text(l, { width: width / 2 - 10 });
    facts(input.party.facts ?? [], MARGIN, width / 2 - 10);
  }
  const partyEnd = doc.y;
  let y = blockTop;
  for (const [label, value] of input.details) {
    doc
      .font("regular")
      .fontSize(9)
      .fillColor(GREY)
      .text(label, MARGIN + width / 2, y, { width: width / 4 });
    doc
      .fillColor("black")
      .text(value, MARGIN + (width * 3) / 4, y, { width: width / 4, align: "right" });
    y = Math.max(doc.y, y + 13);
  }
  doc.y = Math.max(partyEnd, y) + 16;

  // Lines.
  const total = input.columns.reduce((a, c) => a + c.width, 0);
  const xs: number[] = [];
  let x = MARGIN;
  for (const c of input.columns) {
    xs.push(x);
    x += (c.width / total) * width;
  }
  const colWidth = (i: number) => (input.columns[i].width / total) * width - 6;
  const header = () => {
    const hy = doc.y;
    doc
      .rect(MARGIN, hy - 3, width, 18)
      .fill("#f0f0f0")
      .fillColor("black");
    doc.font("bold").fontSize(8.5);
    input.columns.forEach((c, i) =>
      text(c.label, xs[i] + 3, hy, { width: colWidth(i), align: c.align ?? "left" }),
    );
    doc.y = hy + 18;
  };
  header();
  doc.font("regular").fontSize(9);
  for (const row of input.rows) {
    const heights = row.map((cell, i) => doc.heightOfString(cell, { width: colWidth(i) }));
    const h = Math.max(12, ...heights) + 6;
    if (doc.y + h > bottom()) {
      doc.addPage();
      header();
      doc.font("regular").fontSize(9);
    }
    const ry = doc.y;
    row.forEach((cell, i) =>
      text(cell, xs[i] + 3, ry + 2, {
        width: colWidth(i),
        align: input.columns[i].align ?? "left",
      }),
    );
    doc
      .moveTo(MARGIN, ry + h)
      .lineTo(MARGIN + width, ry + h)
      .strokeColor(LINE)
      .lineWidth(0.5)
      .stroke();
    doc.y = ry + h;
  }

  // Totals, right-aligned.
  doc.y += 8;
  for (const [i, [label, value]] of input.totals.entries()) {
    if (doc.y + 16 > bottom()) doc.addPage();
    const last = i === input.totals.length - 1;
    const ty = doc.y;
    doc.font(last ? "bold" : "regular").fontSize(last ? 10.5 : 9.5);
    text(label, MARGIN + width / 2, ty, { width: width / 4 });
    text(value, MARGIN + (width * 3) / 4, ty, { width: width / 4, align: "right" });
    doc.y = Math.max(doc.y, ty + 15);
  }

  for (const note of input.notes ?? []) {
    doc.moveDown(0.8);
    if (doc.y + 30 > bottom()) doc.addPage();
    doc.font("regular").fontSize(8.5).fillColor(GREY).text(note, MARGIN, doc.y, { width });
    doc.fillColor("black");
  }

  // Page numbers.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font("regular").fontSize(8).fillColor(GREY);
    text(`${i + 1} / ${range.count}`, MARGIN, doc.page.height - MARGIN - 10, {
      width,
      align: "center",
      lineBreak: false,
    });
  }
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

/** A PDF download (or inline view with `?inline=1`). */
export function pdfResponse(request: Request, pdf: Uint8Array, filename: string): Response {
  const inline = new URL(request.url).searchParams.get("inline") === "1";
  return new Response(pdf as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
