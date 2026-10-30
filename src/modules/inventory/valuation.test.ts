import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  addLandedCost,
  costInbound,
  costInboundReversal,
  costOutbound,
  emptyValuation,
  negate,
  revalue,
  type ValuationState,
} from "./valuation";

const d = (v: string) => new Decimal(v);
const show = (s: ValuationState) => ({
  quantity: s.quantity.toFixed(),
  totalValue: s.totalValue.toFixed(),
  averageUnitCost: s.averageUnitCost?.toFixed() ?? null,
  costMissing: s.costMissing,
});

describe("moving weighted average", () => {
  it("averages receipts at different costs", () => {
    let s = costInbound(emptyValuation(), d("10"), { kind: "entered", unitCost: d("2") }).state;
    s = costInbound(s, d("30"), { kind: "entered", unitCost: d("3") }).state;
    expect(show(s)).toEqual({
      quantity: "40",
      totalValue: "110",
      averageUnitCost: "2.75",
      costMissing: false,
    });
  });

  it("issues at the current average and leaves the average unchanged", () => {
    let s = costInbound(emptyValuation(), d("40"), { kind: "entered", unitCost: d("2.75") }).state;
    const out = costOutbound(s, d("15"));
    expect(out.valueDelta.toFixed()).toBe("-41.25");
    expect(out.unitCost?.toFixed()).toBe("2.75");
    expect(out.costSource).toBe("AVERAGE");
    s = out.state;
    expect(show(s)).toMatchObject({ quantity: "25", totalValue: "68.75", averageUnitCost: "2.75" });
  });

  it("rounds each issue but the last unit out takes the exact remaining value", () => {
    // 3 units worth 10.0000: 10/3 → 3.3333, then 6.6667/2 → 3.3334 (half up), then the rest
    const s = costInbound(emptyValuation(), d("3"), {
      kind: "entered",
      unitCost: d("3.333333"),
    }).state;
    expect(s.totalValue.toFixed()).toBe("10");
    const a = costOutbound(s, d("1"));
    const b = costOutbound(a.state, d("1"));
    const c = costOutbound(b.state, d("1"));
    expect([a, b, c].map((m) => m.valueDelta.toFixed())).toEqual(["-3.3333", "-3.3334", "-3.3333"]);
    expect(show(c.state)).toEqual({
      quantity: "0",
      totalValue: "0",
      averageUnitCost: "3.3333",
      costMissing: false,
    });
  });

  it("never lets value go negative or stay behind at zero quantity", () => {
    let s = costInbound(emptyValuation(), d("0.000001"), {
      kind: "entered",
      unitCost: d("0.4"),
    }).state;
    expect(s.totalValue.toFixed()).toBe("0"); // rounds to 0.0000
    s = costOutbound(s, d("0.000001")).state;
    expect(show(s)).toMatchObject({ quantity: "0", totalValue: "0" });
  });

  it("refuses to issue more than is valued", () => {
    const s = costInbound(emptyValuation(), d("1"), { kind: "entered", unitCost: d("1") }).state;
    expect(() => costOutbound(s, d("2"))).toThrow(RangeError);
  });

  it("values a movement without its own cost at the current, then the last known average", () => {
    let s = costInbound(emptyValuation(), d("4"), { kind: "entered", unitCost: d("5") }).state;
    const gain = costInbound(s, d("1"), { kind: "average" });
    expect(gain.valueDelta.toFixed()).toBe("5");
    expect(gain.costSource).toBe("AVERAGE");
    s = costOutbound(gain.state, d("5")).state;
    const after = costInbound(s, d("2"), { kind: "average" });
    expect(after.valueDelta.toFixed()).toBe("10");
    expect(after.unitCost?.toFixed()).toBe("5");
  });

  it("never invents a cost: no known average adds zero value and flags cost missing", () => {
    const m = costInbound(emptyValuation(), d("3"), { kind: "average" });
    expect(m.costSource).toBe("NONE");
    expect(m.unitCost).toBeNull();
    expect(m.valueDelta.toFixed()).toBe("0");
    expect(m.state.costMissing).toBe(true);
    // Value ÷ quantity (0) is not recorded as an average.
    expect(m.state.averageUnitCost).toBeNull();
    // Later costed stock does not clear the flag; the uncosted units are still there.
    const next = costInbound(m.state, d("1"), { kind: "entered", unitCost: d("4") });
    expect(next.state.costMissing).toBe(true);
    expect(next.state.averageUnitCost).toBeNull();
    // Nor is the understated mix used for more stock without a cost of its own.
    const more = costInbound(next.state, d("1"), { kind: "average" });
    expect(more.costSource).toBe("NONE");
    expect(more.valueDelta.toFixed()).toBe("0");
    // Using up all stock clears the flag without leaving a made-up average behind.
    const empty = costOutbound(more.state, d("5")).state;
    expect(empty.costMissing).toBe(false);
    expect(empty.averageUnitCost).toBeNull();
    expect(costInbound(empty, d("1"), { kind: "average" }).costSource).toBe("NONE");
  });

  it("transfer legs move value without changing it", () => {
    const source = costInbound(emptyValuation(), d("10"), {
      kind: "entered",
      unitCost: d("1.5"),
    }).state;
    const out = costOutbound(source, d("4"));
    const dest = costInbound(emptyValuation(), d("4"), {
      kind: "transfer",
      value: out.valueDelta.negated(),
      unitCost: out.unitCost,
      costMissing: source.costMissing,
    });
    expect(dest.valueDelta.plus(out.valueDelta).toFixed()).toBe("0");
    expect(dest.costSource).toBe("TRANSFER");
    expect(show(dest.state)).toMatchObject({
      quantity: "4",
      totalValue: "6",
      averageUnitCost: "1.5",
    });
  });

  it("a transfer of uncosted stock carries the flag", () => {
    const source = costInbound(emptyValuation(), d("2"), { kind: "average" }).state;
    const out = costOutbound(source, d("1"));
    const dest = costInbound(emptyValuation(), d("1"), {
      kind: "transfer",
      value: out.valueDelta.negated(),
      unitCost: out.unitCost,
      costMissing: source.costMissing,
    });
    expect(dest.state.costMissing).toBe(true);
  });

  it("restoring an issue puts back exactly its value", () => {
    let s = costInbound(emptyValuation(), d("10"), { kind: "entered", unitCost: d("2") }).state;
    const out = costOutbound(s, d("3"));
    s = costInbound(out.state, d("5"), { kind: "entered", unitCost: d("4") }).state;
    const back = costInbound(s, d("3"), {
      kind: "restore",
      value: out.valueDelta.negated(),
      unitCost: out.unitCost,
    });
    expect(back.valueDelta.toFixed()).toBe("6");
    expect(back.costSource).toBe("RESTORED");
    expect(show(back.state)).toMatchObject({ quantity: "15", totalValue: "40" });
  });

  it("handles zero-value movements of uncosted stock without negative zeros", () => {
    const s = costInbound(emptyValuation(), d("2"), { kind: "average" }).state;
    const out = costOutbound(s, d("1"));
    expect(out.valueDelta.isNegative()).toBe(false); // 0, not -0
    const back = costInbound(out.state, d("1"), {
      kind: "restore",
      value: negate(out.valueDelta),
      unitCost: out.unitCost,
    });
    expect(back.valueDelta.toFixed()).toBe("0");
    expect(back.state.costMissing).toBe(true);
  });

  it("reversing an inbound entry takes out exactly the value it added", () => {
    // 10 @ 10 on hand, then 10 received at a wrong price of 100.
    let s = costInbound(emptyValuation(), d("10"), { kind: "entered", unitCost: d("10") }).state;
    const wrong = costInbound(s, d("10"), { kind: "entered", unitCost: d("100") });
    s = wrong.state;
    expect(s.totalValue.toFixed()).toBe("1100");
    const reversal = costInboundReversal(s, d("10"), wrong.valueDelta);
    expect(reversal.valueDelta.toFixed()).toBe("-1000");
    expect(reversal.costSource).toBe("RESTORED");
    expect(show(reversal.state)).toEqual({
      quantity: "10",
      totalValue: "100",
      averageUnitCost: "10",
      costMissing: false,
    });
  });

  it("caps an inbound reversal at the value on hand and flags what is left", () => {
    let s = costInbound(emptyValuation(), d("10"), { kind: "entered", unitCost: d("10") }).state;
    const wrong = costInbound(s, d("10"), { kind: "entered", unitCost: d("100") });
    // 15 issued at the average (55): 825 out, 275 left on 5 units.
    s = costOutbound(wrong.state, d("15")).state;
    s = costInbound(s, d("10"), { kind: "entered", unitCost: d("10") }).state; // 15 units, 375
    const reversal = costInboundReversal(s, d("10"), wrong.valueDelta);
    expect(reversal.valueDelta.toFixed()).toBe("-375");
    expect(show(reversal.state)).toMatchObject({
      quantity: "5",
      totalValue: "0",
      costMissing: true,
    });
    // Taking out the last units always takes the exact remaining value.
    const all = costInboundReversal(s, d("15"), d("9999"));
    expect(all.valueDelta.toFixed()).toBe("-375");
    expect(all.state.costMissing).toBe(false);
  });

  it("revaluation sets the average, changes value and clears the flag", () => {
    const s = costInbound(emptyValuation(), d("8"), { kind: "average" }).state;
    const r = revalue(s, d("1.25"));
    expect(r.valueDelta.toFixed()).toBe("10");
    expect(show(r.state)).toEqual({
      quantity: "8",
      totalValue: "10",
      averageUnitCost: "1.25",
      costMissing: false,
    });
    expect(() => revalue(s, d("-1"))).toThrow(RangeError);
  });

  it("revaluation with nothing on hand only sets the cost used next", () => {
    const r = revalue(emptyValuation(), d("3"));
    expect(r.valueDelta.toFixed()).toBe("0");
    expect(costInbound(r.state, d("2"), { kind: "average" }).valueDelta.toFixed()).toBe("6");
  });
});

describe("landed cost", () => {
  const state = (quantity: string, value: string, avg: string | null, costMissing = false) => ({
    quantity: new Decimal(quantity),
    totalValue: new Decimal(value),
    averageUnitCost: avg === null ? null : new Decimal(avg),
    costMissing,
  });
  const d = (v: string) => new Decimal(v);

  it("adds the whole charge while all received units are on hand", () => {
    const r = addLandedCost(state("100", "2000", "20"), d("150"), d("50"));
    expect(r.capitalized.toFixed()).toBe("150");
    expect(r.expensed.toFixed()).toBe("0");
    expect(r.state.totalValue.toFixed()).toBe("2150");
    expect(r.state.averageUnitCost?.toFixed()).toBe("21.5");
    expect(r.state.quantity.toFixed()).toBe("100");
  });

  it("adds only the share of units still on hand and expenses the rest", () => {
    const r = addLandedCost(state("30", "600", "20"), d("100"), d("40"));
    expect(r.capitalized.toFixed()).toBe("75");
    expect(r.expensed.toFixed()).toBe("25");
    expect(r.state.totalValue.toFixed()).toBe("675");
    expect(r.state.averageUnitCost?.toFixed()).toBe("22.5");
  });

  it("expenses everything when nothing is on hand", () => {
    const before = state("0", "0", "20");
    const r = addLandedCost(before, d("100"), d("40"));
    expect(r.capitalized.toFixed()).toBe("0");
    expect(r.expensed.toFixed()).toBe("100");
    expect(r.state).toBe(before);
  });

  it("keeps the last reliable average while costs are missing", () => {
    const r = addLandedCost(state("10", "100", "10", true), d("5"), d("10"));
    expect(r.state.totalValue.toFixed()).toBe("105");
    expect(r.state.averageUnitCost?.toFixed()).toBe("10");
    expect(r.state.costMissing).toBe(true);
  });

  it("rounds the capitalized share at money scale and keeps the parts exact", () => {
    const r = addLandedCost(state("1", "10", "10"), d("10"), d("3"));
    expect(r.capitalized.toFixed()).toBe("3.3333");
    expect(r.capitalized.plus(r.expensed).toFixed()).toBe("10");
    expect(() => addLandedCost(state("1", "1", "1"), d("-1"), d("1"))).toThrow(RangeError);
    expect(() => addLandedCost(state("1", "1", "1"), d("1"), d("0"))).toThrow(RangeError);
  });
});
