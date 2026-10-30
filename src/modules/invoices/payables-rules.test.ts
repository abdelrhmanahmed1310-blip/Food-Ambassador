import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  agingBucket,
  allocateOldestFirst,
  daysOverdue,
  journalLines,
  paymentStatus,
} from "./payables-rules";

const d = (v: string) => new Decimal(v);
const accounts = { payables: "2100", purchases: "5100", inputVat: "1410", payments: "1010" };

describe("aging", () => {
  it("counts days past the due date into buckets", () => {
    expect(daysOverdue("2026-10-01", "2026-10-31")).toBe(30);
    expect(agingBucket("2026-10-31", "2026-10-31")).toBe("CURRENT");
    expect(agingBucket("2026-11-15", "2026-10-31")).toBe("CURRENT");
    expect(agingBucket("2026-10-30", "2026-10-31")).toBe("D1_30");
    expect(agingBucket("2026-10-01", "2026-10-31")).toBe("D1_30");
    expect(agingBucket("2026-09-30", "2026-10-31")).toBe("D31_60");
    expect(agingBucket("2026-08-02", "2026-10-31")).toBe("D61_90");
    expect(agingBucket("2026-08-01", "2026-10-31")).toBe("D90_PLUS");
    expect(agingBucket("2026-07-31", "2026-10-31")).toBe("D90_PLUS");
    // Across a DST change and a leap day the count stays whole days.
    expect(daysOverdue("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("derives the payment status", () => {
    expect(paymentStatus(d("100"), d("0"))).toBe("OPEN");
    expect(paymentStatus(d("100"), d("0.01"))).toBe("PARTLY_PAID");
    expect(paymentStatus(d("100"), d("100"))).toBe("PAID");
  });
});

describe("oldest-first allocation", () => {
  it("pays the earliest due first and leaves the rest unapplied", () => {
    const r = allocateOldestFirst(d("250"), [
      { id: "b", open: d("100"), dueDate: "2026-10-20", number: "PI-2" },
      { id: "a", open: d("100"), dueDate: "2026-10-10", number: "PI-1" },
      { id: "z", open: d("0"), dueDate: "2026-10-01", number: "PI-0" },
      { id: "c", open: d("30"), dueDate: "2026-10-20", number: "PI-3" },
    ]);
    expect(r.allocations.map((a) => [a.invoiceId, a.amount.toFixed()])).toEqual([
      ["a", "100"],
      ["b", "100"],
      ["c", "30"],
    ]);
    expect(r.unapplied.toFixed()).toBe("20");
    const part = allocateOldestFirst(d("150"), [
      { id: "a", open: d("100"), dueDate: "2026-10-10", number: "PI-1" },
      { id: "b", open: d("100"), dueDate: "2026-10-20", number: "PI-2" },
    ]);
    expect(part.allocations.map((a) => a.amount.toFixed())).toEqual(["100", "50"]);
    expect(part.unapplied.toFixed()).toBe("0");
  });
});

describe("journal lines", () => {
  const balanced = (lines: ReturnType<typeof journalLines>) =>
    lines.reduce((a, l) => a.plus(l.debit).minus(l.credit), new Decimal(0)).isZero();

  it("splits input VAT when registered and capitalizes it otherwise", () => {
    const inv = { kind: "INVOICE" as const, net: d("100"), tax: d("15"), gross: d("115") };
    const reg = journalLines(inv, accounts, true);
    expect(reg.map((l) => [l.account, l.debit.toFixed(), l.credit.toFixed()])).toEqual([
      ["5100", "100", "0"],
      ["1410", "15", "0"],
      ["2100", "0", "115"],
    ]);
    expect(balanced(reg)).toBe(true);
    const unreg = journalLines(inv, accounts, false);
    expect(unreg.map((l) => [l.account, l.debit.toFixed(), l.credit.toFixed()])).toEqual([
      ["5100", "115", "0"],
      ["2100", "0", "115"],
    ]);
  });

  it("reverses for credit notes and moves cash for payments", () => {
    const cn = journalLines(
      { kind: "CREDIT_NOTE", net: d("10"), tax: d("1.5"), gross: d("11.5") },
      accounts,
      true,
    );
    expect(cn.map((l) => [l.account, l.debit.toFixed(), l.credit.toFixed()])).toEqual([
      ["2100", "11.5", "0"],
      ["5100", "0", "10"],
      ["1410", "0", "1.5"],
    ]);
    expect(balanced(cn)).toBe(true);
    const pay = journalLines({ kind: "PAYMENT", gross: d("50") }, accounts, true);
    expect(pay.map((l) => [l.account, l.debit.toFixed(), l.credit.toFixed()])).toEqual([
      ["2100", "50", "0"],
      ["1010", "0", "50"],
    ]);
  });
});
