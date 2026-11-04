import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  allocatePick,
  inspectionOutcome,
  locationFits,
  suggestLocation,
  walkOrder,
  type PickCandidate,
  type RuleCandidate,
} from "./rules";

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

describe("pick allocation (ADR-102)", () => {
  const c = (over: Partial<PickCandidate>) => ({
    key: "k",
    locationId: "L",
    locationCode: "A-01",
    zone: "STORAGE" as const,
    lotId: null,
    expiresOn: null,
    bestBeforeOn: null,
    firstReceivedAt: new Date("2026-01-01"),
    recallHold: false,
    available: new Decimal(10),
    ...over,
  });
  it("picks the first-expiring lot first, then picking areas before storage", () => {
    const plan = allocatePick(
      [
        c({ key: "late", expiresOn: "2026-12-30", zone: "PICKING" }),
        c({ key: "soon-store", expiresOn: "2026-11-20", zone: "STORAGE", locationCode: "B" }),
        c({ key: "soon-pick", expiresOn: "2026-11-20", zone: "PICKING", locationCode: "Z" }),
      ],
      "15",
      "2026-11-04",
    );
    expect(plan.picks.map((p) => [p.candidate.key, p.quantity.toFixed()])).toEqual([
      ["soon-pick", "10"],
      ["soon-store", "5"],
    ]);
    expect(plan.shortfall.toFixed()).toBe("0");
  });

  it("never picks from quarantine or dispatch, expired, recalled or reserved stock", () => {
    const plan = allocatePick(
      [
        c({ key: "q", zone: "QUARANTINE" }),
        c({ key: "d", zone: "DISPATCH" }),
        c({ key: "x", expiresOn: "2026-11-03" }),
        c({ key: "r", recallHold: true }),
        c({ key: "held", available: new Decimal(0) }),
        c({
          key: "ok",
          zone: null,
          locationId: null,
          locationCode: null,
          available: new Decimal(4),
        }),
      ],
      "6",
      "2026-11-04",
    );
    expect(plan.picks.map((p) => p.candidate.key)).toEqual(["ok"]);
    expect(plan.shortfall.toFixed()).toBe("2");
  });

  it("sorts a pick sheet by location", () => {
    expect(
      walkOrder([
        { locationCode: null, sku: "A" },
        { locationCode: "B-2", sku: "B" },
        { locationCode: "A-9", sku: "C" },
      ]).map((r) => r.sku),
    ).toEqual(["C", "B", "A"]);
  });
});
