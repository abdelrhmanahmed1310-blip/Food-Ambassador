import { describe, expect, it } from "vitest";
import { percentile, ticketStats } from "./kitchen-rules";

describe("kitchen statistics (ADR-108)", () => {
  it("interpolates percentiles", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([300], 0.9)).toBe(300);
    expect(percentile([60, 120, 180, 240], 0.5)).toBe(150);
    // rank 0.9 × 9 = 8.1 → 900 + 0.1 × 100
    expect(percentile([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 0.9)).toBeCloseTo(910);
  });

  it("summarises tickets against their targets", () => {
    const s = ticketStats([
      { seconds: 300, targetSeconds: 600 },
      { seconds: 600, targetSeconds: 600 },
      { seconds: 900, targetSeconds: 600 },
      { seconds: 1200, targetSeconds: null },
    ]);
    expect([s.tickets, s.medianSeconds, s.meanSeconds]).toEqual([4, 750, 750]);
    // 1 of the 3 tickets with a target was on time: reaching 600 s is late, as on the screen.
    expect(s.withinTarget?.toFixed(4)).toBe("0.3333");
    expect(ticketStats([])).toEqual({
      tickets: 0,
      medianSeconds: null,
      p90Seconds: null,
      meanSeconds: null,
      withinTarget: null,
    });
  });
});
