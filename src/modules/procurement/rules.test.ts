import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  approvalOutcome,
  isCancellable,
  isClosable,
  isEditable,
  isReceivable,
  lineTotal,
  maxAcceptable,
  statusFromReceipts,
  supplierPerformance,
} from "./rules";

const d = (v: string) => new Decimal(v);

describe("purchase order rules", () => {
  it("approves automatically without a threshold or at/below it", () => {
    expect(approvalOutcome(d("5000"), null)).toBe("AUTO_APPROVED");
    expect(approvalOutcome(d("1000"), d("1000"))).toBe("AUTO_APPROVED");
    expect(approvalOutcome(d("1000.0001"), d("1000"))).toBe("NEEDS_APPROVAL");
    expect(approvalOutcome(d("0.01"), d("0"))).toBe("NEEDS_APPROVAL");
  });

  it("computes line totals exactly at money scale", () => {
    expect(lineTotal(d("3"), d("0.333333")).toFixed()).toBe("1");
    expect(lineTotal(d("12.5"), d("4.4")).toFixed()).toBe("55");
  });

  it("limits accepted quantity by the tolerance", () => {
    expect(maxAcceptable(d("100"), d("0")).toFixed()).toBe("100");
    expect(maxAcceptable(d("100"), d("0.05")).toFixed()).toBe("105");
    expect(maxAcceptable(d("0.333333"), d("0.1")).toFixed()).toBe("0.366666");
    expect(() => maxAcceptable(d("1"), d("1.5"))).toThrow(RangeError);
  });

  it("derives the status from accepted quantities", () => {
    const line = (ordered: string, received: string) => ({
      orderedBase: d(ordered),
      receivedBase: d(received),
    });
    expect(statusFromReceipts([line("10", "0"), line("5", "0")])).toBe("APPROVED");
    expect(statusFromReceipts([line("10", "4"), line("5", "0")])).toBe("PARTIALLY_RECEIVED");
    expect(statusFromReceipts([line("10", "10"), line("5", "6")])).toBe("RECEIVED");
  });

  it("allows actions only in the right states", () => {
    expect(isEditable("DRAFT")).toBe(true);
    expect(isEditable("PENDING_APPROVAL")).toBe(false);
    expect(isReceivable("APPROVED")).toBe(true);
    expect(isReceivable("PARTIALLY_RECEIVED")).toBe(true);
    expect(isReceivable("PENDING_APPROVAL")).toBe(false);
    expect(isReceivable("CLOSED")).toBe(false);
    expect(isCancellable("APPROVED", false)).toBe(true);
    expect(isCancellable("APPROVED", true)).toBe(false);
    expect(isCancellable("RECEIVED", false)).toBe(false);
    expect(isClosable("PARTIALLY_RECEIVED")).toBe(true);
    expect(isClosable("DRAFT")).toBe(false);
  });
});

describe("supplier performance", () => {
  it("reports no rates when there is nothing to measure", () => {
    const p = supplierPerformance({ receipts: [], finishedOrders: [] });
    expect(p).toMatchObject({ receipts: 0, onTimeRate: null, fillRate: null, rejectionRate: null });
    expect(p.priceVariance.toFixed()).toBe("0");
  });

  it("measures on-time delivery, fill rate, rejections and price variance", () => {
    const p = supplierPerformance({
      receipts: [
        {
          receivedOn: "2026-10-01",
          expectedOn: "2026-10-01",
          receivedBase: d("10"),
          acceptedBase: d("9"),
          rejectedBase: d("1"),
          priceVariance: d("4.5"),
        },
        {
          receivedOn: "2026-10-05",
          expectedOn: "2026-10-03",
          receivedBase: d("10"),
          acceptedBase: d("10"),
          rejectedBase: d("0"),
          priceVariance: d("-1"),
        },
        {
          receivedOn: "2026-10-06",
          expectedOn: null,
          receivedBase: d("20"),
          acceptedBase: d("20"),
          rejectedBase: d("0"),
          priceVariance: d("0"),
        },
      ],
      finishedOrders: [
        { orderedBase: d("20"), acceptedBase: d("19") },
        // Over-delivery does not lift the fill rate above 100 %.
        { orderedBase: d("20"), acceptedBase: d("22") },
      ],
    });
    expect(p.receipts).toBe(3);
    expect(p.onTimeRate?.toFixed()).toBe("0.5");
    expect(p.fillRate?.toFixed()).toBe("0.975");
    expect(p.rejectionRate?.toFixed()).toBe("0.025");
    expect(p.priceVariance.toFixed()).toBe("3.5");
  });
});
