import { describe, expect, it } from "vitest";
import { inspectionOutcome, locationFits, suggestLocation, type RuleCandidate } from "./rules";

const chilledShelf = {
  id: "L1",
  zone: "STORAGE",
  temperatureZone: "CHILLED",
  archived: false,
} as const;
const dryShelf = {
  id: "L2",
  zone: "STORAGE",
  temperatureZone: "AMBIENT",
  archived: false,
} as const;
const dock = { id: "L3", zone: "RECEIVING", temperatureZone: "CHILLED", archived: false } as const;
const milk = { id: "P1", categoryId: "DAIRY", storageRequirement: "CHILLED" } as const;
const rule = (r: Partial<RuleCandidate> & Pick<RuleCandidate, "id" | "priority" | "location">) =>
  ({ productId: null, categoryId: null, storageRequirement: null, ...r }) as RuleCandidate;

describe("put-away suggestion (ADR-101)", () => {
  it("takes the first matching rule by priority", () => {
    const rules = [
      rule({ id: "any", priority: 50, location: chilledShelf }),
      rule({
        id: "dairy",
        priority: 10,
        categoryId: "DAIRY",
        location: { ...chilledShelf, id: "L9" },
      }),
    ];
    expect(suggestLocation(rules, milk)).toEqual({
      source: "RULE",
      ruleId: "dairy",
      locationId: "L9",
    });
  });

  it("skips rules that point at the wrong temperature, a non-storage zone or an archived place", () => {
    const rules = [
      rule({ id: "dry", priority: 1, location: dryShelf }),
      rule({ id: "dock", priority: 2, location: dock }),
      rule({ id: "gone", priority: 3, location: { ...chilledShelf, archived: true } }),
      rule({ id: "other", priority: 4, productId: "P2", location: chilledShelf }),
    ];
    expect(suggestLocation(rules, milk)).toEqual({ source: "NONE" });
    expect(suggestLocation(rules, milk, [dryShelf, chilledShelf])).toEqual({
      source: "SAME_PRODUCT",
      locationId: "L1",
    });
  });

  it("fits only storage and picking places at the product's temperature", () => {
    expect(locationFits({ ...chilledShelf, zone: "PICKING" }, milk)).toBe(true);
    expect(locationFits(dock, milk)).toBe(false);
    expect(locationFits(dryShelf, milk)).toBe(false);
  });
});

describe("receiving inspection outcome (ADR-101)", () => {
  const base = { total: "10", checksPassed: true, hasRejectionReason: false, hasNote: false };
  it("accepts, rejects or splits", () => {
    expect(inspectionOutcome({ ...base, accepted: "10" })).toMatchObject({
      ok: true,
      decision: "ACCEPTED",
    });
    const split = inspectionOutcome({ ...base, accepted: "7.5", hasRejectionReason: true });
    expect(split).toMatchObject({ ok: true, decision: "PARTIAL" });
    expect(split.ok && split.rejected.toFixed()).toBe("2.5");
    expect(inspectionOutcome({ ...base, accepted: "0", hasRejectionReason: true })).toMatchObject({
      decision: "REJECTED",
    });
  });
  it("refuses out-of-range quantities, rejections without reason, failed checks accepted silently", () => {
    expect(inspectionOutcome({ ...base, accepted: "11" })).toEqual({
      ok: false,
      problem: "ACCEPTED_OUT_OF_RANGE",
    });
    expect(inspectionOutcome({ ...base, accepted: "9" })).toEqual({
      ok: false,
      problem: "REJECTION_REASON_REQUIRED",
    });
    expect(inspectionOutcome({ ...base, accepted: "10", checksPassed: false })).toEqual({
      ok: false,
      problem: "INSPECTION_NOTE_REQUIRED",
    });
    expect(
      inspectionOutcome({ ...base, accepted: "10", checksPassed: false, hasNote: true }),
    ).toMatchObject({ ok: true });
  });
});
