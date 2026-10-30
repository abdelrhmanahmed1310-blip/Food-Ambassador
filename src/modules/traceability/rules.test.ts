import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { summarizeTrace, type TraceEntry } from "./rules";

let n = 0;
const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const e = (
  movementType: string,
  qty: string,
  day: number,
  warehouseId = "MAIN",
  reverses: string | null = null,
): TraceEntry => ({
  id: `e${++n}`,
  movementType,
  warehouseId,
  quantityDelta: new Decimal(qty),
  occurredAt: at(day),
  reversesEntryId: reverses,
});

describe("lot trace", () => {
  it("separates origins, exits and internal moves and keeps the balance", () => {
    const receipt = e("RECEIPT", "100", 1);
    const out = e("TRANSFER_OUT", "-40", 2);
    const into = e("TRANSFER_IN", "40", 2, "KITCHEN");
    const hold = e("STATUS_CHANGE", "-10", 3);
    const held = e("STATUS_CHANGE", "10", 3);
    const waste = e("WRITE_OFF", "-5", 4, "KITCHEN");
    const s = summarizeTrace([waste, receipt, out, into, hold, held]);
    expect(s.origins).toEqual([receipt.id]);
    expect(s.exits).toEqual([waste.id]);
    expect(s.internal).toHaveLength(4);
    expect(s.received.toFixed()).toBe("100");
    expect(s.exited.toFixed()).toBe("5");
    expect(s.onHand.toFixed()).toBe("95");
    expect([...s.warehouses.keys()]).toEqual(["MAIN", "KITCHEN"]);
    expect(s.gaps).toEqual([]);
  });

  it("reports origins without a supplier", () => {
    const opening = e("OPENING_BALANCE", "10", 1);
    const found = e("COUNT_ADJUSTMENT", "2", 2);
    const s = summarizeTrace([opening, found]);
    expect(s.gaps.map((g) => [g.kind, g.entryId, g.quantity])).toEqual([
      ["ORIGIN_WITHOUT_SUPPLIER", opening.id, "10"],
      ["ORIGIN_WITHOUT_SUPPLIER", found.id, "2"],
    ]);
  });

  it("treats reversed entries and their reversals as internal", () => {
    const receipt = e("RECEIPT", "10", 1);
    const reversal = e("REVERSAL", "-10", 2, "MAIN", receipt.id);
    const s = summarizeTrace([receipt, reversal]);
    expect(s.origins).toEqual([]);
    expect(s.received.toFixed()).toBe("0");
    expect(s.onHand.toFixed()).toBe("0");
  });

  it("flags usage without a lot where and after the lot was present", () => {
    const receipt = e("RECEIPT", "10", 5);
    const before = e("WRITE_OFF", "-1", 4);
    const after = e("WRITE_OFF", "-2", 6);
    const elsewhere = e("WRITE_OFF", "-3", 6, "OTHER");
    const s = summarizeTrace([receipt], [before, after, elsewhere]);
    expect(s.gaps).toEqual([
      { kind: "UNLOTTED_USAGE", entryId: after.id, warehouseId: "MAIN", quantity: "2" },
    ]);
  });
});
