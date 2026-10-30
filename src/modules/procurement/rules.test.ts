import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  allocateCharge,
  approvalOutcome,
  isCancellable,
  isClosable,
  isEditable,
  isReceivable,
  lineTotal,
  maxAcceptable,
  statusFromReceipts,
  suggestReorder,
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

describe("reorder suggestions", () => {
  const base = {
    minBase: d("20"),
    maxBase: d("100"),
    availableBase: d("15"),
    onOrderBase: d("0"),
    basePerPurchaseUnit: d("1"),
    minOrderPurchaseUnits: null,
  };

  it("orders up to the maximum once available + on order reaches the minimum", () => {
    expect(suggestReorder({ ...base, availableBase: d("21") })).toBeNull();
    const s = suggestReorder({ ...base, availableBase: d("20") });
    expect(s?.purchaseUnits.toFixed()).toBe("80");
    expect(s?.projectedBase.toFixed()).toBe("20");
  });

  it("counts stock already on order", () => {
    expect(suggestReorder({ ...base, onOrderBase: d("10") })).toBeNull(); // 25 > 20
    expect(suggestReorder({ ...base, onOrderBase: d("5") })?.base.toFixed()).toBe("80");
  });

  it("rounds up to whole purchase units and respects the supplier minimum", () => {
    // 85 eggs needed, cases of 30 → 3 cases (90 eggs).
    const eggs = suggestReorder({ ...base, basePerPurchaseUnit: d("30") });
    expect(eggs?.purchaseUnits.toFixed()).toBe("3");
    expect(eggs?.base.toFixed()).toBe("90");
    const min = suggestReorder({
      ...base,
      basePerPurchaseUnit: d("30"),
      minOrderPurchaseUnits: d("5"),
    });
    expect(min?.purchaseUnits.toFixed()).toBe("5");
  });

  it("never suggests when the maximum is already covered", () => {
    expect(suggestReorder({ ...base, minBase: d("100"), availableBase: d("100") })).toBeNull();
    expect(() => suggestReorder({ ...base, basePerPurchaseUnit: d("0") })).toThrow(RangeError);
  });
});

describe("landed cost allocation", () => {
  const sum = (xs: Decimal[]) => xs.reduce((a, x) => a.plus(x), new Decimal(0)).toFixed();

  it("splits in proportion to the weights", () => {
    expect(allocateCharge(d("300"), [d("200"), d("400")]).map((x) => x.toFixed())).toEqual([
      "100",
      "200",
    ]);
  });

  it("adds up to the amount exactly, remainders to the largest fractions", () => {
    const shares = allocateCharge(d("100"), [d("1"), d("1"), d("1")]);
    expect(shares.map((x) => x.toFixed())).toEqual(["33.3334", "33.3333", "33.3333"]);
    expect(sum(shares)).toBe("100");
    const uneven = allocateCharge(d("0.0005"), [d("1"), d("2"), d("2")]);
    expect(uneven.map((x) => x.toFixed())).toEqual(["0.0001", "0.0002", "0.0002"]);
    const many = allocateCharge(d("1"), [d("3"), d("7"), d("11"), d("13"), d("0")]);
    expect(sum(many)).toBe("1");
    expect(many[4].toFixed()).toBe("0");
  });

  it("refuses nothing to allocate over and bad input", () => {
    expect(() => allocateCharge(d("10"), [d("0"), d("0")])).toThrow(RangeError);
    expect(() => allocateCharge(d("0"), [d("1")])).toThrow(RangeError);
    expect(() => allocateCharge(d("10"), [d("-1"), d("2")])).toThrow(RangeError);
  });
});
