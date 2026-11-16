import { Decimal } from "@/lib/decimal";

/**
 * POS simulator rules (ADR-135), pure so they are unit-tested and run in the
 * browser: tendering, and the summary of a practice session. Simulated
 * sales are never sent to the server.
 */

export type SimPayment = "CASH" | "CARD" | "SPLIT";

export interface SimLine {
  itemId: string;
  name: string;
  quantity: number;
  gross: string;
  tax: string;
}

export interface SimSale {
  number: number;
  at: string;
  channel: string;
  /** "SCAN" when at least one line was scanned, else "PUNCH". */
  entry: "PUNCH" | "SCAN" | "MIXED";
  lines: SimLine[];
  total: string;
  tax: string;
  discount: string;
  payment: SimPayment;
  cash: string;
  card: string;
  change: string;
  voided?: boolean;
}

/**
 * Check a payment: cash may be tendered above what it pays (change); card
 * pays exactly; a split pays the card part by card and the rest in cash.
 */
export function tender(
  total: Decimal,
  payment: SimPayment,
  input: { tendered?: string; cardPart?: string },
): { ok: true; cash: Decimal; card: Decimal; change: Decimal } | { ok: false; problem: string } {
  const num = (v?: string) =>
    v && /^\d+(\.\d{1,3})?$/.test(v.trim()) ? new Decimal(v.trim()) : null;
  if (total.lte(0)) return { ok: false, problem: "SIM_NOTHING_TO_PAY" };
  if (payment === "CARD")
    return { ok: true, cash: new Decimal(0), card: total, change: new Decimal(0) };
  if (payment === "CASH") {
    const given = num(input.tendered) ?? total;
    if (given.lt(total)) return { ok: false, problem: "SIM_TENDERED_TOO_LOW" };
    return { ok: true, cash: total, card: new Decimal(0), change: given.minus(total) };
  }
  const card = num(input.cardPart);
  if (!card || card.lte(0) || card.gte(total)) return { ok: false, problem: "SIM_SPLIT_INVALID" };
  const cashDue = total.minus(card);
  const given = num(input.tendered) ?? cashDue;
  if (given.lt(cashDue)) return { ok: false, problem: "SIM_TENDERED_TOO_LOW" };
  return { ok: true, cash: cashDue, card, change: given.minus(cashDue) };
}

/** The session's "Z report": sales, VAT, discounts, by payment, by channel, by entry, best sellers. */
export function summarize(sales: readonly SimSale[]) {
  const live = sales.filter((s) => !s.voided);
  const sum = (f: (s: SimSale) => string) => live.reduce((a, s) => a.plus(f(s)), new Decimal(0));
  const group = (key: (s: SimSale) => string) => {
    const m = new Map<string, { count: number; total: Decimal }>();
    for (const s of live) {
      const k = key(s);
      const g = m.get(k) ?? { count: 0, total: new Decimal(0) };
      m.set(k, { count: g.count + 1, total: g.total.plus(s.total) });
    }
    return [...m].map(([k, v]) => ({ key: k, count: v.count, total: v.total.toFixed(2) }));
  };
  const items = new Map<string, { name: string; quantity: number; gross: Decimal }>();
  for (const s of live)
    for (const l of s.lines) {
      const i = items.get(l.itemId) ?? { name: l.name, quantity: 0, gross: new Decimal(0) };
      items.set(l.itemId, {
        name: l.name,
        quantity: i.quantity + l.quantity,
        gross: i.gross.plus(l.gross),
      });
    }
  return {
    sales: live.length,
    voided: sales.length - live.length,
    total: sum((s) => s.total).toFixed(2),
    tax: sum((s) => s.tax).toFixed(2),
    discount: sum((s) => s.discount).toFixed(2),
    cash: sum((s) => s.cash).toFixed(2),
    card: sum((s) => s.card).toFixed(2),
    average: live.length
      ? sum((s) => s.total)
          .dividedBy(live.length)
          .toFixed(2)
      : "0.00",
    byChannel: group((s) => s.channel),
    byPayment: group((s) => s.payment),
    byEntry: group((s) => s.entry),
    topItems: [...items.values()]
      .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
      .slice(0, 10)
      .map((i) => ({ name: i.name, quantity: i.quantity, gross: i.gross.toFixed(2) })),
  };
}

/** The session as CSV, one row per line sold, for checking in a spreadsheet. */
export function sessionCsv(sales: readonly SimSale[]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    ["sale", "time", "channel", "entry", "payment", "voided", "item", "quantity", "gross", "tax"],
  ];
  for (const s of sales)
    for (const l of s.lines)
      rows.push([
        String(s.number),
        s.at,
        s.channel,
        s.entry,
        s.payment,
        s.voided ? "yes" : "no",
        l.name,
        String(l.quantity),
        l.gross,
        l.tax,
      ]);
  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}
