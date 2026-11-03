import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { calibrationOutcome, dueState, nextDueDate } from "./equipment-rules";

const d = (v: string) => new Decimal(v);

describe("calibrationOutcome (ADR-099)", () => {
  it("passes within the tolerance, inclusive", () => {
    // Probe in iced water: reference 0 °C, ±1 °C.
    expect(calibrationOutcome(d("0"), d("0.4"), d("1"))).toBe("PASS");
    expect(calibrationOutcome(d("0"), d("-1"), d("1"))).toBe("PASS");
    expect(calibrationOutcome(d("0"), d("1.1"), d("1"))).toBe("FAIL");
    // Scale with a 1 kg test weight, ±0.005 kg.
    expect(calibrationOutcome(d("1"), d("0.994"), d("0.005"))).toBe("FAIL");
    expect(() => calibrationOutcome(d("0"), d("0"), d("-1"))).toThrow();
  });
});

describe("due dates", () => {
  it("come from the given date or the interval", () => {
    expect(nextDueDate("2026-11-03", "2027-01-01", 30)).toBe("2027-01-01");
    expect(nextDueDate("2026-11-03", undefined, 30)).toBe("2026-12-03");
    expect(nextDueDate("2026-11-03", undefined, null)).toBeNull();
  });
  it("are flagged 30 days ahead and when passed", () => {
    expect(dueState(null, "2026-11-03")).toBe("NOT_PLANNED");
    expect(dueState("2026-11-02", "2026-11-03")).toBe("OVERDUE");
    expect(dueState("2026-11-03", "2026-11-03")).toBe("DUE_SOON");
    expect(dueState("2026-12-03", "2026-11-03")).toBe("DUE_SOON");
    expect(dueState("2026-12-04", "2026-11-03")).toBe("OK");
  });
});
