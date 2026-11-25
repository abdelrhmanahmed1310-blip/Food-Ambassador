import { describe, expect, it } from "vitest";
import { computeStatement, crossedThreshold, isListedEmail, planSchema } from "./rules";

/** Plans and statements (ADR-147). */

describe("billing rules", () => {
  it("reads a plan the operator entered, with no price unless one is given", () => {
    const plan = planSchema.parse({
      code: "pro",
      name: "Pro",
      currency: "sar",
      monthlyFee: "499",
      pricing: {
        "agent.actions": { included: "100", unitPrice: "0.5" },
        "ai.input_tokens": { unitPrice: "12", per: "1000000" },
      },
    });
    expect(plan).toMatchObject({ code: "PRO", currency: "SAR" });
    expect(plan.pricing["agent.actions"]).toEqual({ included: 100, unitPrice: "0.5", per: 1 });
    expect(plan.pricing["ai.input_tokens"]).toEqual({ included: 0, unitPrice: "12", per: 1000000 });
    expect(
      planSchema.safeParse({ code: "X", name: "x", currency: "SAR", monthlyFee: "-1" }).success,
    ).toBe(false);
    expect(
      planSchema.safeParse({
        code: "X",
        name: "x",
        currency: "SAR",
        monthlyFee: "1",
        pricing: { "agent.actions": { per: "7" } },
      }).success,
    ).toBe(false);
  });

  it("charges the fee and what is used beyond what is included, per line, to the cent", () => {
    const s = computeStatement(
      {
        monthlyFee: "499.0000",
        pricing: {
          "agent.actions": { included: 100, unitPrice: "0.5", per: 1 },
          "ai.input_tokens": { included: 1_000_000, unitPrice: "12", per: 1_000_000 },
          "mcp.calls": { included: 0, unitPrice: "0.001", per: 1 },
        },
      },
      { "agent.actions": 130, "ai.input_tokens": 2_500_000, "mcp.calls": 1234, "agent.runs": 30 },
    );
    expect(s.lines.map((l) => [l.kind, l.metric, l.billable, l.amount])).toEqual([
      ["FEE", null, 0, "499.00"],
      ["USAGE", "agent.runs", 0, "0.00"], // used, not priced: listed at no charge
      ["USAGE", "agent.actions", 30, "15.00"],
      ["USAGE", "ai.input_tokens", 1_500_000, "18.00"],
      ["USAGE", "mcp.calls", 1234, "1.23"],
    ]);
    expect(s.total).toBe("533.23");
    // Nothing used and nothing priced: just the fee.
    expect(computeStatement({ monthlyFee: "0", pricing: {} }, {})).toEqual({
      lines: [expect.objectContaining({ kind: "FEE", amount: "0.00" })],
      total: "0.00",
    });
  });

  it("knows operators by email and warns at 80 % and at the limit", () => {
    expect(isListedEmail(" Ops@Example.com, b@x.io ", "ops@example.com")).toBe(true);
    expect(isListedEmail(undefined, "ops@example.com")).toBe(false);
    expect(isListedEmail("", "")).toBe(false);
    expect([
      crossedThreshold(79, 100),
      crossedThreshold(80, 100),
      crossedThreshold(100, 100),
      crossedThreshold(5, null),
      crossedThreshold(0, 0),
    ]).toEqual([null, 80, 100, null, 100]);
  });
});
