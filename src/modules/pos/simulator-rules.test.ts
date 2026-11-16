import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { sessionCsv, summarize, tender, type SimSale } from "./simulator-rules";

const sale = (n: number, over: Partial<SimSale> = {}): SimSale => ({
  number: n,
  at: "2026-11-16T09:00:00Z",
  channel: "DINE_IN",
  entry: "PUNCH",
  lines: [{ itemId: "cola", name: "Cola", quantity: 2, gross: "50.00", tax: "6.52" }],
  total: "50.00",
  tax: "6.52",
  discount: "0.00",
  payment: "CASH",
  cash: "50.00",
  card: "0.00",
  change: "0.00",
  ...over,
});

describe("POS simulator (ADR-135)", () => {
  it("tenders cash with change, card exactly, and splits", () => {
    const total = new Decimal("47.50");
    expect(tender(total, "CASH", { tendered: "50" })).toMatchObject({
      ok: true,
      change: new Decimal("2.5"),
    });
    expect(tender(total, "CASH", {})).toMatchObject({ ok: true, change: new Decimal(0) });
    expect(tender(total, "CASH", { tendered: "40" })).toEqual({
      ok: false,
      problem: "SIM_TENDERED_TOO_LOW",
    });
    expect(tender(total, "CARD", { tendered: "100" })).toMatchObject({ ok: true, card: total });
    const split = tender(total, "SPLIT", { cardPart: "30", tendered: "20" });
    expect(split).toMatchObject({
      ok: true,
      card: new Decimal(30),
      cash: new Decimal("17.5"),
      change: new Decimal("2.5"),
    });
    expect(tender(total, "SPLIT", { cardPart: "47.50" })).toEqual({
      ok: false,
      problem: "SIM_SPLIT_INVALID",
    });
    expect(tender(new Decimal(0), "CASH", {})).toEqual({
      ok: false,
      problem: "SIM_NOTHING_TO_PAY",
    });
  });

  it("summarises a session, leaving voided sales out", () => {
    const sales = [
      sale(1),
      sale(2, {
        channel: "TAKEAWAY",
        entry: "SCAN",
        payment: "CARD",
        cash: "0.00",
        card: "25.00",
        total: "25.00",
        tax: "3.26",
        lines: [{ itemId: "water", name: "Water", quantity: 5, gross: "25.00", tax: "3.26" }],
      }),
      sale(3, { voided: true }),
    ];
    const s = summarize(sales);
    expect([s.sales, s.voided, s.total, s.tax, s.cash, s.card, s.average]).toEqual([
      2,
      1,
      "75.00",
      "9.78",
      "50.00",
      "25.00",
      "37.50",
    ]);
    expect(s.byChannel).toEqual([
      { key: "DINE_IN", count: 1, total: "50.00" },
      { key: "TAKEAWAY", count: 1, total: "25.00" },
    ]);
    expect(s.topItems.map((i) => `${i.name}:${i.quantity}`)).toEqual(["Water:5", "Cola:2"]);
  });

  it("exports one CSV row per line, quoting where needed", () => {
    const csv = sessionCsv([
      sale(1, {
        lines: [{ itemId: "x", name: 'Tea, "large"', quantity: 1, gross: "5.00", tax: "0.65" }],
      }),
    ]);
    expect(csv.split("\n")[1]).toBe(
      '1,2026-11-16T09:00:00Z,DINE_IN,PUNCH,CASH,no,"Tea, ""large""",1,5.00,0.65',
    );
  });
});
