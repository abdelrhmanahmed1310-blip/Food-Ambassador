import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { checkSelection, resolvePrice, unitPrice, type PriceRow } from "./rules";

const d = (v: string) => new Decimal(v);
const row = (
  p: Partial<Omit<PriceRow, "price">> & { price: string; effectiveFrom: string },
): PriceRow => ({
  channel: "DINE_IN",
  branchId: null,
  includesTax: true,
  ...p,
  price: d(p.price),
});

describe("menu prices (ADR-058)", () => {
  const rows = [
    row({ price: "100", effectiveFrom: "2026-01-01" }),
    row({ price: "110", effectiveFrom: "2026-06-01" }),
    row({ price: "120", effectiveFrom: "2026-06-01", branchId: "airport" }),
    row({ price: "90", effectiveFrom: "2026-01-01", channel: "TAKEAWAY" }),
  ];
  it("uses the branch's own price, else the price for all branches, latest in effect", () => {
    const at = (branchId: string, date: string, channel: PriceRow["channel"] = "DINE_IN") =>
      resolvePrice(rows, { channel, branchId, date })?.price.toFixed() ?? null;
    expect(at("city", "2026-03-01")).toBe("100");
    expect(at("city", "2026-07-01")).toBe("110");
    expect(at("airport", "2026-07-01")).toBe("120");
    expect(at("airport", "2026-03-01")).toBe("100"); // its own price starts later
    expect(at("city", "2026-07-01", "TAKEAWAY")).toBe("90");
    expect(at("city", "2026-07-01", "DELIVERY")).toBeNull(); // not sold on delivery
    expect(at("city", "2025-12-31")).toBeNull();
  });
});

describe("modifier choices (ADR-058)", () => {
  const groups = [
    { groupId: "size", minSelect: 1, maxSelect: 1, optionIds: ["s", "m", "l"] },
    { groupId: "extras", minSelect: 0, maxSelect: 2, optionIds: ["cheese", "egg", "olives"] },
  ];
  it("requires the minimum, refuses more than the maximum and unknown options", () => {
    expect(checkSelection(groups, ["m"])).toEqual([]);
    expect(checkSelection(groups, ["m", "cheese", "egg"])).toEqual([]);
    expect(checkSelection(groups, [])).toEqual([{ problem: "TOO_FEW", groupId: "size", min: 1 }]);
    expect(checkSelection(groups, ["s", "l"])).toEqual([
      { problem: "TOO_MANY", groupId: "size", max: 1 },
    ]);
    expect(checkSelection(groups, ["m", "cheese", "egg", "olives"])).toEqual([
      { problem: "TOO_MANY", groupId: "extras", max: 2 },
    ]);
    expect(checkSelection(groups, ["m", "bacon"])).toEqual([
      { problem: "UNKNOWN_OPTION", optionId: "bacon" },
    ]);
    expect(checkSelection(groups, ["m", "m"])).toEqual([]); // the same option counts once
  });
  it("adds option price changes and never goes below zero", () => {
    expect(unitPrice(d("50"), [d("10"), d("5.5")]).toFixed()).toBe("65.5");
    expect(unitPrice(d("50"), [d("-10")]).toFixed()).toBe("40");
    expect(unitPrice(d("5"), [d("-10")]).toFixed()).toBe("0");
  });
});
