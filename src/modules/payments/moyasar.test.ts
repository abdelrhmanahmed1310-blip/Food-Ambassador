import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { readInvoice, toMinorUnits } from "./moyasar";

describe("Moyasar amounts and invoices (ADR-066)", () => {
  it("sends amounts in halalas and refuses fractions of a halala", () => {
    expect(toMinorUnits(new Decimal("115.5"), "SAR")).toBe(11550);
    expect(toMinorUnits(new Decimal("0.01"), "SAR")).toBe(1);
    expect(() => toMinorUnits(new Decimal("1.005"), "SAR")).toThrow(RangeError);
  });
  it("reads the state and the paying card, keeping only the last 4 digits", () => {
    expect(readInvoice({ status: "initiated", amount: 100, payments: [] })).toEqual({
      state: "PENDING",
      amountMinor: 100,
      payment: null,
    });
    const paid = readInvoice({
      status: "paid",
      amount: 11550,
      payments: [
        { id: "f1", status: "failed", source: { company: "visa", number: "4111-11XX-XXXX-0002" } },
        { id: "p2", status: "paid", source: { company: "mada", number: "4464-04XX-XXXX-1234" } },
      ],
    });
    expect(paid).toEqual({
      state: "PAID",
      amountMinor: 11550,
      payment: { id: "p2", scheme: "MADA", last4: "1234" },
    });
    expect(readInvoice({ status: "canceled" }).state).toBe("CANCELLED");
    expect(readInvoice({ status: "failed" }).state).toBe("FAILED");
    expect(
      readInvoice({
        status: "paid",
        payments: [{ id: "a", status: "paid", source: { type: "applepay", company: "master" } }],
      }).payment,
    ).toEqual({ id: "a", scheme: "MASTERCARD", last4: null });
  });
});
