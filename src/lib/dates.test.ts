import { describe, expect, it } from "vitest";
import { isCalendarDate } from "./dates";

describe("isCalendarDate", () => {
  it("accepts real dates only", () => {
    expect(isCalendarDate("2026-11-01")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-1-01")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
  });
});
