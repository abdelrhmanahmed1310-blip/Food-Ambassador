import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  addDays,
  businessDate,
  countAdjustment,
  expiryState,
  fefoAllocate,
  fefoSort,
  isExpired,
  transitionPermission,
} from "./rules";

describe("business date", () => {
  it("uses the given time zone", () => {
    const instant = new Date("2026-03-01T22:30:00Z");
    expect(businessDate("UTC", instant)).toBe("2026-03-01");
    expect(businessDate("Africa/Cairo", instant)).toBe("2026-03-02");
    expect(businessDate("America/New_York", instant)).toBe("2026-03-01");
  });

  it("adds days across month and leap boundaries", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("expiry", () => {
  it("treats stock expiring today as usable and yesterday as expired", () => {
    expect(isExpired("2026-05-10", "2026-05-10")).toBe(false);
    expect(isExpired("2026-05-09", "2026-05-10")).toBe(true);
    expect(isExpired(null, "2026-05-10")).toBe(false);
  });

  it("classifies expiry windows", () => {
    expect(expiryState(null, "2026-05-10", 7)).toBe("NONE");
    expect(expiryState("2026-05-09", "2026-05-10", 7)).toBe("EXPIRED");
    expect(expiryState("2026-05-17", "2026-05-10", 7)).toBe("EXPIRING");
    expect(expiryState("2026-05-18", "2026-05-10", 7)).toBe("OK");
  });
});

const lot = (
  id: string,
  expiresOn: string | null,
  available: string,
  receivedDay = 1,
  bestBeforeOn: string | null = null,
) => ({
  lotId: id,
  expiresOn,
  bestBeforeOn,
  firstReceivedAt: new Date(`2026-01-0${receivedDay}T00:00:00Z`),
  available: new Decimal(available),
});

describe("FEFO", () => {
  it("orders by expiry, then best-before, then receipt, with undated lots last", () => {
    const sorted = fefoSort([
      lot("none", null, "5"),
      lot("late", "2026-06-01", "5"),
      lot("early-new", "2026-05-01", "5", 3),
      lot("early-old", "2026-05-01", "5", 1),
      lot("bb", "2026-05-01", "5", 5, "2026-04-01"),
    ]);
    expect(sorted.map((s) => s.lotId)).toEqual(["bb", "early-old", "early-new", "late", "none"]);
  });

  it("allocates across lots, skipping expired and empty ones", () => {
    const { picks, shortfall } = fefoAllocate(
      [
        lot("expired", "2026-04-01", "100"),
        lot("a", "2026-05-01", "3"),
        lot("empty", "2026-05-02", "0"),
        lot("b", "2026-06-01", "10"),
      ],
      "5",
      "2026-04-15",
    );
    expect(picks.map((p) => [p.candidate.lotId, p.quantity.toFixed()])).toEqual([
      ["a", "3"],
      ["b", "2"],
    ]);
    expect(shortfall.toFixed()).toBe("0");
  });

  it("reports a shortfall when stock is insufficient", () => {
    const { shortfall } = fefoAllocate([lot("a", "2026-05-01", "2")], "5", "2026-04-15");
    expect(shortfall.toFixed()).toBe("3");
  });
});

describe("counts and status transitions", () => {
  it("adjusts by counted minus expected at snapshot", () => {
    expect(countAdjustment("10", "8.5").toFixed()).toBe("-1.5");
    expect(countAdjustment("0", "4").toFixed()).toBe("4");
    expect(countAdjustment("3", "3").toFixed()).toBe("0");
  });

  it("requires release permission only for releases", () => {
    expect(transitionPermission("AVAILABLE", "QUARANTINE")).toBe("inventory.quarantine");
    expect(transitionPermission("QUARANTINE", "AVAILABLE")).toBe("inventory.quarantine.release");
    expect(transitionPermission("ON_HOLD", "AVAILABLE")).toBe("inventory.quarantine.release");
    expect(transitionPermission("REJECTED", "AVAILABLE")).toBeNull();
    expect(transitionPermission("AVAILABLE", "AVAILABLE")).toBeNull();
  });
});
