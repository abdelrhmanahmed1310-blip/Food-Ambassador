import { describe, expect, it } from "vitest";
import { prepStats, stationFor, ticketUrgency } from "./kitchen-rules";

describe("kitchen routing (ADR-063)", () => {
  const routes = [
    { stationId: "grill", categoryId: "mains", menuItemId: null },
    { stationId: "cold", categoryId: null, menuItemId: "salad-burger" },
  ];
  it("sends an item by its own route, then its category, then the default", () => {
    expect(stationFor({ id: "salad-burger", categoryId: "mains" }, routes, "pass")).toBe("cold");
    expect(stationFor({ id: "burger", categoryId: "mains" }, routes, "pass")).toBe("grill");
    expect(stationFor({ id: "cake", categoryId: "desserts" }, routes, "pass")).toBe("pass");
    expect(stationFor({ id: "cola", categoryId: "drinks" }, routes, null)).toBeNull();
  });
});

describe("ticket timing", () => {
  it("warns from 75 % of the target and marks late at the target", () => {
    expect(ticketUrgency(8 * 60_000, 12)).toBe("ok");
    expect(ticketUrgency(9 * 60_000, 12)).toBe("warning");
    expect(ticketUrgency(12 * 60_000, 12)).toBe("late");
  });
  it("reports count, average and 90th percentile", () => {
    expect(prepStats([])).toEqual({ count: 0, average: null, p90: null });
    expect(prepStats([10, 2, 4, 6, 8, 12, 14, 16, 18, 20])).toEqual({
      count: 10,
      average: 11,
      p90: 18,
    });
    expect(prepStats([7])).toEqual({ count: 1, average: 7, p90: 7 });
  });
});
