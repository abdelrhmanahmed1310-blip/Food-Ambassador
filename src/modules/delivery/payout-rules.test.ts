import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { matchLine, parsePayoutCsv, PAYOUT_TEMPLATE, payoutTotals } from "./payout-rules";

const H = "order_id,description,gross,commission,fees,vat_on_fees,net\n";

describe("delivery payout statements (ADR-075)", () => {
  it("reads the template, adjustments included", () => {
    const r = parsePayoutCsv(PAYOUT_TEMPLATE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].externalId).toBe("HS-100231");
    expect(r.lines[0].net.toFixed(2)).toBe("42.93");
    expect(r.lines[1].externalId).toBeNull();
    expect(r.lines[1].description).toBe("Marketing campaign");
  });

  it("adds several rows for one order together (an order and its later refund)", () => {
    const r = parsePayoutCsv(
      `${H}A1,,50,10,0,1.5,38.5\nA1,refund,-10,-2,0,-0.3,-7.7\nB2,,20,4,0,0.6,15.4\n`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.lines.map((l) => [l.lineNo, l.externalId, l.gross.toFixed(2), l.net.toFixed(2)]),
    ).toEqual([
      [1, "A1", "40.00", "30.80"],
      [2, "B2", "20.00", "15.40"],
    ]);
  });

  it("refuses the whole file when a row is wrong, naming the row and column", () => {
    const r = parsePayoutCsv(`${H}A1,,50,10,0,1.5,30\n,,0,0,5,0.75,-5.75\nB2,,abc,,,,1\n`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      { row: 2, column: "net", message: "netDoesNotAddUp" },
      { row: 3, column: "description", message: "adjustmentNeedsDescription" },
      { row: 4, column: "gross", message: "invalidDecimal" },
    ]);
    expect(parsePayoutCsv("order_id,net\nA,1\n")).toEqual({
      ok: false,
      errors: [{ row: 1, column: "gross", message: "missingColumn" }],
    });
    expect(parsePayoutCsv(H)).toEqual({
      ok: false,
      errors: [{ row: 1, column: "", message: "noRows" }],
    });
  });

  it("matches a line with the order received, within a cent", () => {
    const line = (gross: string, id: string | null = "A1") => ({
      externalId: id,
      gross: new Decimal(gross),
    });
    const order = (
      status: "ACCEPTED" | "CANCELLED" | "REJECTED" | "PENDING",
      total = "45",
      settledElsewhere = false,
    ) => ({
      status,
      total: new Decimal(total),
      settledElsewhere,
    });
    expect(matchLine(line("45.00"), order("ACCEPTED"))).toBe("MATCHED");
    expect(matchLine(line("45.01"), order("ACCEPTED"))).toBe("MATCHED");
    expect(matchLine(line("44.50"), order("ACCEPTED"))).toBe("AMOUNT_DIFFERS");
    expect(matchLine(line("45"), undefined)).toBe("NOT_FOUND");
    expect(matchLine(line("45"), order("CANCELLED"))).toBe("CANCELLED_ORDER");
    expect(matchLine(line("45"), order("REJECTED"))).toBe("NOT_ACCEPTED");
    expect(matchLine(line("45"), order("PENDING"))).toBe("NOT_ACCEPTED");
    expect(matchLine(line("45"), order("ACCEPTED", "45", true))).toBe("ALREADY_PAID");
    expect(matchLine(line("0", null), undefined)).toBe("ADJUSTMENT");
  });

  it("totals the statement and the effective commission rate", () => {
    const d = (v: string) => new Decimal(v);
    const t = payoutTotals([
      { gross: d("100"), commission: d("20"), fees: d("2"), vatOnFees: d("3.3"), net: d("74.7") },
      { gross: d("0"), commission: d("0"), fees: d("10"), vatOnFees: d("1.5"), net: d("-11.5") },
    ]);
    expect(t.gross.toFixed(2)).toBe("100.00");
    expect(t.net.toFixed(2)).toBe("63.20");
    expect(t.effectiveRate!.toFixed(2)).toBe("32.00");
    expect(payoutTotals([]).effectiveRate).toBeNull();
  });
});
