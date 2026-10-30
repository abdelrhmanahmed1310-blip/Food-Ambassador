import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  automaticSeverity,
  canClose,
  isOverdue,
  statusAfterActionAdded,
  withinLimits,
} from "./rules";

const d = (v: string) => new Decimal(v);

describe("food safety rules", () => {
  it("judges readings against inclusive limits; a missing bound does not limit", () => {
    expect(withinLimits(d("5"), d("0"), d("5"))).toBe(true);
    expect(withinLimits(d("5.1"), d("0"), d("5"))).toBe(false);
    expect(withinLimits(d("-0.1"), d("0"), d("5"))).toBe(false);
    expect(withinLimits(d("-25"), null, d("-18"))).toBe(true);
    expect(withinLimits(d("-17.9"), null, d("-18"))).toBe(false);
    expect(withinLimits(d("63"), d("63"), null)).toBe(true);
  });

  it("closes a non-conformance only when every action is verified", () => {
    expect(canClose("ACTION_PLANNED", [{ status: "VERIFIED" }, { status: "VERIFIED" }])).toBe(true);
    expect(canClose("ACTION_PLANNED", [{ status: "VERIFIED" }, { status: "DONE" }])).toBe(false);
    expect(canClose("OPEN", [])).toBe(true);
    expect(canClose("CLOSED", [])).toBe(false);
  });

  it("moves to action planned when an action is added and flags overdue actions", () => {
    expect(statusAfterActionAdded("OPEN")).toBe("ACTION_PLANNED");
    expect(statusAfterActionAdded("INVESTIGATING")).toBe("ACTION_PLANNED");
    expect(statusAfterActionAdded("ACTION_PLANNED")).toBe("ACTION_PLANNED");
    expect(isOverdue("2026-11-01", "OPEN", "2026-11-02")).toBe(true);
    expect(isOverdue("2026-11-02", "OPEN", "2026-11-02")).toBe(false);
    expect(isOverdue("2026-11-01", "DONE", "2026-11-02")).toBe(false);
    expect(isOverdue(null, "OPEN", "2026-11-02")).toBe(false);
    expect(automaticSeverity(1)).toBe("MEDIUM");
    expect(automaticSeverity(3)).toBe("HIGH");
  });
});
