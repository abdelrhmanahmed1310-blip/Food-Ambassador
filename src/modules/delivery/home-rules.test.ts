import { describe, expect, it } from "vitest";
import { mapLink, median, minutesBetween, riderStats } from "./home-rules";

const at = (m: number) => new Date(Date.UTC(2026, 10, 4, 12, m));

describe("own delivery rider rules (ADR-117)", () => {
  it("measures minutes and medians", () => {
    expect([
      minutesBetween(at(0), at(25)),
      minutesBetween(at(0), null),
      minutesBetween(at(10), at(5)),
    ]).toEqual([25, null, 0]);
    expect([median([]), median([30]), median([10, 40, 20]), median([10, 20, 30, 41])]).toEqual([
      null,
      30,
      20,
      25,
    ]);
  });

  it("sums each rider's deliveries", () => {
    const stats = riderStats([
      {
        riderUserId: "a",
        status: "DELIVERED",
        createdAt: at(0),
        pickedUpAt: at(10),
        deliveredAt: at(30),
      },
      {
        riderUserId: "a",
        status: "DELIVERED",
        createdAt: at(0),
        pickedUpAt: at(20),
        deliveredAt: at(30),
      },
      {
        riderUserId: "a",
        status: "FAILED",
        createdAt: at(0),
        pickedUpAt: at(5),
        deliveredAt: null,
      },
      {
        riderUserId: null,
        status: "CANCELLED",
        createdAt: at(0),
        pickedUpAt: null,
        deliveredAt: null,
      },
    ]);
    expect(stats).toEqual([
      { riderUserId: "a", delivered: 2, failed: 1, medianRoadMinutes: 15, medianTotalMinutes: 30 },
    ]);
  });

  it("links to a map search without calling any service", () => {
    expect(mapLink("King Fahd Rd, Riyadh")).toBe(
      "https://www.google.com/maps/search/?api=1&query=King%20Fahd%20Rd%2C%20Riyadh",
    );
  });
});
