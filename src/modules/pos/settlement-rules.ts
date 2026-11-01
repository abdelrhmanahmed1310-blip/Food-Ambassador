import { Decimal } from "@/lib/decimal";
import { parseCsvRecords } from "@/lib/csv";

/** Card settlement reconciliation (DECISIONS.md ADR-065). Pure. */

export interface SettlementRow {
  line: number;
  date: string;
  terminalId: string | null;
  approvalCode: string;
  amount: Decimal;
  fee: Decimal;
}

export interface CardPaymentRef {
  id: string;
  /** Business date of the order (YYYY-MM-DD). */
  date: string;
  terminalId: string | null;
  approvalCode: string;
  /** What the card was charged: the order share plus the tip. */
  charged: Decimal;
}

export type Match = "MATCHED" | "AMOUNT_MISMATCH" | "UNMATCHED";

const DAY = 86_400_000;
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;

/**
 * Match settlement lines to card payments: same approval code, same
 * terminal when both are known, within 2 days. Equal amount = matched; a
 * candidate with another amount = mismatch (fee or tip entered wrongly);
 * none = unmatched. Each payment is used once, rows in file order.
 */
export function matchSettlement(
  rows: readonly SettlementRow[],
  payments: readonly CardPaymentRef[],
): Map<number, { paymentId: string | null; match: Match }> {
  const free = new Set(payments.map((p) => p.id));
  const out = new Map<number, { paymentId: string | null; match: Match }>();
  for (const r of rows) {
    const candidates = payments
      .filter(
        (p) =>
          free.has(p.id) &&
          p.approvalCode.toUpperCase() === r.approvalCode.toUpperCase() &&
          (!p.terminalId || !r.terminalId || p.terminalId === r.terminalId) &&
          daysApart(p.date, r.date) <= 2,
      )
      .sort((a, b) => daysApart(a.date, r.date) - daysApart(b.date, r.date));
    const exact = candidates.find((p) => p.charged.equals(r.amount));
    const chosen = exact ?? candidates[0];
    if (chosen) free.delete(chosen.id);
    out.set(r.line, {
      paymentId: chosen?.id ?? null,
      match: exact ? "MATCHED" : chosen ? "AMOUNT_MISMATCH" : "UNMATCHED",
    });
  }
  return out;
}

export type CsvProblem = { line: number; field: string };

const AMOUNT = /^\d+(\.\d{1,4})?$/;

/**
 * The settlement file: a header row with date, approval_code and amount, and
 * optionally terminal_id and fee. Dates YYYY-MM-DD; amounts with a dot.
 */
export function parseSettlementCsv(text: string): {
  rows: SettlementRow[];
  problems: CsvProblem[];
} {
  const { headers, records } = parseCsvRecords(text);
  const problems: CsvProblem[] = [];
  for (const h of ["date", "approval_code", "amount"])
    if (!headers.includes(h)) problems.push({ line: 1, field: h });
  if (problems.length > 0) return { rows: [], problems };
  const rows: SettlementRow[] = [];
  records.forEach((r, i) => {
    const line = i + 2;
    const bad = (field: string) => problems.push({ line, field });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(r.date))) return bad("date");
    if (!/^[A-Za-z0-9]{1,12}$/.test(r.approval_code)) return bad("approval_code");
    if (!AMOUNT.test(r.amount) || new Decimal(r.amount).isZero()) return bad("amount");
    const fee = r.fee ?? "";
    if (fee !== "" && !AMOUNT.test(fee)) return bad("fee");
    rows.push({
      line,
      date: r.date,
      terminalId: r.terminal_id ? r.terminal_id : null,
      approvalCode: r.approval_code,
      amount: new Decimal(r.amount),
      fee: new Decimal(fee === "" ? "0" : fee),
    });
  });
  return { rows, problems };
}
