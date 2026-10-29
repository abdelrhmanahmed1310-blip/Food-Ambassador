import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  costInbound,
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
