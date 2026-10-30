import { Decimal } from "@/lib/decimal";

/**
 * Pure payables rules (DECISIONS.md ADR-039): aging, oldest-first
 * allocation and the journal lines of the accounting export.
 */

export const AGING_BUCKETS = ["CURRENT", "D1_30", "D31_60", "D61_90", "D90_PLUS"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

const DAY = 86_400_000;

/** Days past due on `asOf` (both YYYY-MM-DD); an invoice without a due date is due on its date. */
export function daysOverdue(dueDate: string, asOf: string): number {
  return Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / DAY);
}

export function agingBucket(dueDate: string, asOf: string): AgingBucket {
  const d = daysOverdue(dueDate, asOf);
  if (d <= 0) return "CURRENT";
  if (d <= 30) return "D1_30";
  if (d <= 60) return "D31_60";
  if (d <= 90) return "D61_90";
  return "D90_PLUS";
}

export type PaymentStatus = "OPEN" | "PARTLY_PAID" | "PAID";

export function paymentStatus(gross: Decimal, settled: Decimal): PaymentStatus {
  if (settled.gte(gross)) return "PAID";
  return settled.gt(0) ? "PARTLY_PAID" : "OPEN";
}

/**
 * Spread `amount` over open invoices, the earliest due first (then the
 * earliest invoice date, then number). Returns the allocations and what is
 * left unapplied.
 */
export function allocateOldestFirst(
  amount: Decimal,
  invoices: ReadonlyArray<{ id: string; open: Decimal; dueDate: string; number: string }>,
): { allocations: Array<{ invoiceId: string; amount: Decimal }>; unapplied: Decimal } {
  const sorted = [...invoices].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number),
  );
  let left = amount;
  const allocations: Array<{ invoiceId: string; amount: Decimal }> = [];
  for (const inv of sorted) {
    if (!left.gt(0)) break;
    if (!inv.open.gt(0)) continue;
    const take = Decimal.min(left, inv.open);
    allocations.push({ invoiceId: inv.id, amount: take });
    left = left.minus(take);
  }
  return { allocations, unapplied: left };
}

export interface Accounts {
  payables: string;
  purchases: string;
  inputVat: string;
  payments: string;
}

export interface JournalLine {
  account: string;
  debit: Decimal;
  credit: Decimal;
}

/**
 * Double-entry lines for one payables document. Without VAT registration
 * the VAT is part of the purchase cost. Every entry balances.
 */
export function journalLines(
  doc:
    | { kind: "INVOICE" | "CREDIT_NOTE"; net: Decimal; tax: Decimal; gross: Decimal }
    | { kind: "PAYMENT"; gross: Decimal },
  accounts: Accounts,
  vatRegistered: boolean,
): JournalLine[] {
  const zero = new Decimal(0);
  if (doc.kind === "PAYMENT")
    return [
      { account: accounts.payables, debit: doc.gross, credit: zero },
      { account: accounts.payments, debit: zero, credit: doc.gross },
    ];
  const split =
    vatRegistered && doc.tax.gt(0)
      ? [
          { account: accounts.purchases, amount: doc.net },
          { account: accounts.inputVat, amount: doc.tax },
        ]
      : [{ account: accounts.purchases, amount: doc.gross }];
  if (doc.kind === "INVOICE")
    return [
      ...split.map((s) => ({ account: s.account, debit: s.amount, credit: zero })),
      { account: accounts.payables, debit: zero, credit: doc.gross },
    ];
  return [
    { account: accounts.payables, debit: doc.gross, credit: zero },
    ...split.map((s) => ({ account: s.account, debit: zero, credit: s.amount })),
  ];
}
