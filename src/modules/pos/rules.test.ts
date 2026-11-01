import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  checkPayments,
  expectedCash,
  lineAmounts,
  liveAt,
  orderTimeProblem,
  refundPortion,
  syncOutcome,
} from "./rules";

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

describe("offline orders (ADR-060)", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m));
  const base = { openedAt: at(0), now: at(50), closedAt: null as Date | null };
  it("accepts an order taken in the shift, late sync included, with a menu from the shift", () => {
    expect(orderTimeProblem({ ...base, orderedAt: at(20), menuAsOf: at(5) })).toBeNull();
    expect(
      orderTimeProblem({ ...base, closedAt: at(30), orderedAt: at(25), menuAsOf: at(1) }),
    ).toBeNull();
  });
  it("refuses orders after the close, before the open or in the future", () => {
    expect(
      orderTimeProblem({ ...base, closedAt: at(30), orderedAt: at(31), menuAsOf: at(1) }),
    ).toBe("ORDER_TIME_OUTSIDE_SHIFT");
    expect(
      orderTimeProblem({
        ...base,
        orderedAt: new Date(at(0).getTime() - 6 * 60_000),
        menuAsOf: at(0),
      }),
    ).toBe("ORDER_TIME_OUTSIDE_SHIFT");
    expect(orderTimeProblem({ ...base, orderedAt: at(56), menuAsOf: at(1) })).toBe(
      "ORDER_TIME_OUTSIDE_SHIFT",
    );
  });
  it("refuses a menu time from before the shift or after the order", () => {
    const before = new Date(at(0).getTime() - 60 * 60_000);
    expect(orderTimeProblem({ ...base, orderedAt: at(20), menuAsOf: before })).toBe(
      "MENU_TIME_INVALID",
    );
    expect(orderTimeProblem({ ...base, orderedAt: at(10), menuAsOf: at(20) })).toBe(
      "MENU_TIME_INVALID",
    );
  });
  it("treats things archived after the menu time as still on sale", () => {
    expect(liveAt(null, at(10))).toBe(true);
    expect(liveAt(at(11), at(10))).toBe(true);
    expect(liveAt(at(10), at(10))).toBe(false);
  });
  it("keeps queued orders until the server has them", () => {
    expect(syncOutcome(200, true)).toBe("recorded");
    expect(syncOutcome(409, true)).toBe("recorded");
    expect(syncOutcome(422, true)).toBe("refused");
    expect(syncOutcome(404, true)).toBe("refused");
    expect(syncOutcome(null, false)).toBe("retry");
    expect(syncOutcome(503, false)).toBe("retry");
    expect(syncOutcome(401, true)).toBe("signedOut");
    expect(syncOutcome(403, true)).toBe("signedOut"); // another user is signed in
    expect(syncOutcome(200, false)).toBe("signedOut"); // redirected to the sign-in page
  });
});
