import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { matches, ratingSummary, rfm, type CustomerStats } from "./rules";

const c = (
  id: string,
  orders: number,
  spend: number,
  lastVisit: string | null,
  extra: Partial<CustomerStats> = {},
): CustomerStats => ({
  customerId: id,
  orders,
  spend: new Decimal(spend),
  lastVisit,
  branchIds: ["B1"],
  marketingConsent: false,
  points: 0,
  ...extra,
});
const today = "2026-11-04";

describe("segments, RFM and ratings (ADR-118)", () => {
  it("matches every condition given, and only those", () => {
    const regular = c("a", 6, 900, "2026-11-01", { marketingConsent: true, points: 120 });
    const lapsed = c("b", 2, 150, "2026-08-01");
    const never = c("c", 0, 0, null);
    const lapsedRule = { windowDays: 365, notVisitedForDays: 60 };
    expect([regular, lapsed, never].map((s) => matches(s, lapsedRule, today))).toEqual([
      false,
      true,
      true,
    ]);
    const vip = {
      windowDays: 365,
      visitedWithinDays: 30,
      minOrders: 5,
      minSpend: "500",
      consentOnly: true,
      minPoints: 100,
    };
    expect([regular, lapsed].map((s) => matches(s, vip, today))).toEqual([true, false]);
    expect(matches(regular, { windowDays: 90, branchIds: ["B2"] }, today)).toBe(false);
    expect(matches(regular, { windowDays: 90, maxOrders: 5 }, today)).toBe(false);
  });

  it("scores recency, frequency and spend by quintile and groups customers", () => {
    const list = [
      c("top", 20, 4000, "2026-11-03"),
      c("fan", 15, 3000, "2026-11-02"),
      c("newbie", 1, 40, "2026-11-04"),
      c("fading", 9, 1500, "2026-06-01"),
      c("gone", 1, 30, "2026-01-10"),
      c("none", 0, 0, null),
    ];
    const g = Object.fromEntries(rfm(list, today).map((x) => [x.customerId, x.group]));
    expect(g).toEqual({
      top: "CHAMPIONS",
      fan: "LOYAL",
      newbie: "NEW",
      fading: "AT_RISK",
      gone: "LOST",
    });
  });

  it("summarises ratings", () => {
    const s = ratingSummary([5, 4, 4, 2, 1]);
    expect([s.count, s.average?.toFixed(1), s.happyShare?.toFixed(2), s.distribution]).toEqual([
      5,
      "3.2",
      "0.60",
      [1, 1, 0, 2, 1],
    ]);
    expect(ratingSummary([]).average).toBeNull();
  });
});
