import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  awardNeedsReason,
  awardedQuantity,
  lowestOffers,
  rfqActions,
  type Offer,
} from "./rfq-rules";

const offer = (id: string, amount: string | null, expired = false): Offer => ({
  quotationLineId: id,
  quotationId: `q-${id}`,
  comparable: amount === null ? null : new Decimal(amount),
  expired,
});

describe("rfqActions", () => {
  it("edits drafts, records and awards sent RFQs, ends there", () => {
    expect(rfqActions("DRAFT")).toEqual({
      edit: true,
      send: true,
      record: false,
      award: false,
      cancel: true,
    });
    expect(rfqActions("SENT")).toMatchObject({ edit: false, record: true, award: true });
    for (const s of ["AWARDED", "CANCELLED"] as const)
      expect(Object.values(rfqActions(s)).some(Boolean)).toBe(false);
  });
});

describe("lowestOffers", () => {
  it("picks the cheapest valid, comparable offers, ties included", () => {
    expect(lowestOffers([offer("a", "100"), offer("b", "90"), offer("c", "90")])).toEqual(
      new Set(["b", "c"]),
    );
    expect(lowestOffers([offer("a", "100"), offer("b", "50", true), offer("c", null)])).toEqual(
      new Set(["a"]),
    );
    expect(lowestOffers([offer("a", null)])).toEqual(new Set());
  });
});

describe("awardNeedsReason", () => {
  const offers = [offer("a", "100"), offer("b", "90"), offer("x", "10", true)];
  it("needs none for the lowest valid offer", () => {
    expect(awardNeedsReason(offers[1], offers)).toBe(false);
    expect(awardNeedsReason(offer("only", null), [offer("only", null)])).toBe(false);
  });
  it("needs one for a dearer offer or when a rate is missing", () => {
    expect(awardNeedsReason(offers[0], offers)).toBe(true);
    const unknown = [offer("a", "100"), offer("b", null)];
    expect(awardNeedsReason(unknown[0], unknown)).toBe(true);
    expect(awardNeedsReason(unknown[1], unknown)).toBe(true);
  });
});

describe("awardedQuantity", () => {
  it("orders what was asked, or what the supplier can supply", () => {
    expect(awardedQuantity(new Decimal(10), null).toFixed()).toBe("10");
    expect(awardedQuantity(new Decimal(10), new Decimal(6)).toFixed()).toBe("6");
    expect(awardedQuantity(new Decimal(10), new Decimal(12)).toFixed()).toBe("10");
  });
});
