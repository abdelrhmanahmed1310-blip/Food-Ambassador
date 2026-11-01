import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { checkPayments, expectedCash, lineAmounts, refundPortion } from "./rules";

const d = (v: string) => new Decimal(v);

describe("POS amounts (ADR-059)", () => {
  it("splits VAT out of prices including it, adds it to prices excluding it, none when not registered", () => {
    expect(lineAmounts(d("57.5"), d("2"), true, d("0.15"), "SAR")).toEqual({
      net: d("100"),
      tax: d("15"),
      gross: d("115"),
    });
    expect(lineAmounts(d("50"), d("2"), false, d("0.14"), "EGP")).toEqual({
      net: d("100"),
      tax: d("14"),
      gross: d("114"),
    });
    expect(lineAmounts(d("33.333"), d("1"), true, null, "EGP").gross.toFixed()).toBe("33.33");
    expect(lineAmounts(d("1.2345"), d("1"), true, d("0.05"), "KWD").gross.toFixed()).toBe("1.235");
  });

  it("requires payments to equal the total; cash may be tendered with change", () => {
    const ok = checkPayments(d("115"), [{ method: "CASH", amount: d("115"), tendered: d("200") }]);
    expect(ok).toEqual({ problems: [], change: d("85") });
    expect(
      checkPayments(d("115"), [
        { method: "CARD", amount: d("65") },
        { method: "CASH", amount: d("50") },
      ]).problems,
    ).toEqual([]);
    expect(checkPayments(d("115"), [{ method: "CARD", amount: d("100") }]).problems).toEqual([
      "PAYMENT_TOTAL_MISMATCH",
    ]);
    expect(
      checkPayments(d("115"), [{ method: "CASH", amount: d("115"), tendered: d("100") }]).problems,
    ).toEqual(["PAYMENT_TENDERED_TOO_LOW"]);
    expect(
      checkPayments(d("115"), [{ method: "CARD", amount: d("115"), tendered: d("120") }]).problems,
    ).toEqual(["PAYMENT_CHANGE_ON_CARD"]);
    expect(checkPayments(d("0"), []).problems).toContain("PAYMENT_EMPTY");
  });

  it("expects float + cash sales − cash refunds + pay-ins − pay-outs in the drawer", () => {
    expect(
      expectedCash({
        openingFloat: d("500"),
        cashSales: d("1200"),
        cashRefunds: d("50"),
        payIns: d("100"),
        payOuts: d("30"),
      }).toFixed(),
    ).toBe("1720");
  });

  it("refunds proportional shares and lets the last part take the remainder", () => {
    const line = { quantity: d("3"), gross: d("100"), tax: d("13.04") };
    const none = { quantity: d("0"), gross: d("0"), tax: d("0") };
    const first = refundPortion(line, none, d("1"), "EGP")!;
    expect([first.gross.toFixed(), first.tax.toFixed()]).toEqual(["33.33", "4.35"]);
    const after = { quantity: d("1"), gross: first.gross, tax: first.tax };
    const rest = refundPortion(line, after, d("2"), "EGP")!;
    expect([rest.gross.toFixed(), rest.tax.toFixed()]).toEqual(["66.67", "8.69"]); // totals exactly 100 / 13.04
    expect(refundPortion(line, after, d("3"), "EGP")).toBeNull(); // more than is left
    expect(refundPortion(line, none, d("0"), "EGP")).toBeNull();
  });
});
