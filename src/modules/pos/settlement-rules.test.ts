import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { matchSettlement, parseSettlementCsv } from "./settlement-rules";

const d = (v: string) => new Decimal(v);
const row = (
  line: number,
  code: string,
  amount: string,
  date = "2026-11-01",
  terminalId: string | null = "T1",
) => ({
  line,
  date,
  terminalId,
  approvalCode: code,
  amount: d(amount),
  fee: d("0"),
});
const pay = (
  id: string,
  code: string,
  charged: string,
  date = "2026-11-01",
  terminalId: string | null = "T1",
) => ({
  id,
  date,
  terminalId,
  approvalCode: code,
  charged: d(charged),
});

describe("card settlement matching (ADR-065)", () => {
  it("matches by approval code and amount, each payment once", () => {
    const r = matchSettlement(
      [row(2, "A1", "115"), row(3, "a1", "115"), row(4, "B2", "50")],
      [pay("p1", "A1", "115"), pay("p2", "B2", "55")],
    );
    expect(r.get(2)).toEqual({ paymentId: "p1", match: "MATCHED" });
    expect(r.get(3)).toEqual({ paymentId: null, match: "UNMATCHED" }); // p1 already paid out
    expect(r.get(4)).toEqual({ paymentId: "p2", match: "AMOUNT_MISMATCH" });
  });
  it("respects terminals and a two-day window, preferring the closest date", () => {
    const r = matchSettlement(
      [
        row(2, "C3", "10", "2026-11-05"),
        row(3, "C3", "10", "2026-11-01", "T2"),
        row(4, "D4", "10", "2026-11-03", null),
      ],
      [
        pay("old", "C3", "10", "2026-11-01"),
        pay("near", "C3", "10", "2026-11-04"),
        pay("d", "D4", "10", "2026-11-02", "T9"),
      ],
    );
    expect(r.get(2)).toEqual({ paymentId: "near", match: "MATCHED" });
    expect(r.get(3)).toEqual({ paymentId: null, match: "UNMATCHED" }); // other terminal
    expect(r.get(4)).toEqual({ paymentId: "d", match: "MATCHED" }); // terminal unknown on one side
  });
  it("reads the settlement file and reports bad lines", () => {
    const ok = parseSettlementCsv(
      "Date,Terminal_ID,Approval_Code,Amount,Fee\n2026-11-01,T1,A1,115.00,1.73\n2026-11-01,,B2,50,\n",
    );
    expect(ok.problems).toEqual([]);
    expect(ok.rows.map((r) => [r.terminalId, r.amount.toFixed(2), r.fee.toFixed(2)])).toEqual([
      ["T1", "115.00", "1.73"],
      [null, "50.00", "0.00"],
    ]);
    expect(parseSettlementCsv("date,amount\n2026-11-01,5").problems).toEqual([
      { line: 1, field: "approval_code" },
    ]);
    const bad = parseSettlementCsv(
      "date,approval_code,amount\n01/11/2026,A,1\n2026-11-01,A-1,1\n2026-11-01,A,0\n2026-11-01,A,1,5x",
    );
    expect(bad.problems.map((p) => p.field)).toEqual(["date", "approval_code", "amount"]);
  });
});
