import { describe, expect, it } from "vitest";
import { distanceMeters, nextKind, PIN_PATTERN, timesheet } from "./attendance-rules";

const at = (s: string) => new Date(s);
const TZ = "Asia/Riyadh"; // UTC+3

describe("attendance rules (ADR-080)", () => {
  it("measures distance from the branch", () => {
    const olaya = { latitude: 24.6905, longitude: 46.6855 };
    expect(distanceMeters(olaya, olaya)).toBe(0);
    // About 111 m per 0.001° of latitude.
    expect(distanceMeters(olaya, { latitude: 24.6915, longitude: 46.6855 })).toBe(111);
  });

  it("alternates clock-in and clock-out; PINs are 4 to 6 digits", () => {
    expect(nextKind(null)).toBe("IN");
    expect(nextKind("IN")).toBe("OUT");
    expect(nextKind("OUT")).toBe("IN");
    expect(["1234", "123456", "123", "1234567", "12a4"].map((p) => PIN_PATTERN.test(p))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("pairs punches into daily hours, a night shift counting for the day it began", () => {
    const days = timesheet(
      [
        { kind: "OUT", at: at("2026-11-01T14:00:00Z") }, // 17:00 local
        { kind: "IN", at: at("2026-11-01T06:00:00Z") }, // 09:00 local
        { kind: "IN", at: at("2026-11-01T18:00:00Z") }, // 21:00 local
        { kind: "OUT", at: at("2026-11-01T23:30:00Z") }, // 02:30 next day local
      ],
      TZ,
      at("2026-11-03T12:00:00Z"),
    );
    expect(days.map((d) => [d.day, d.minutes, d.issues])).toEqual([
      ["2026-11-01", 8 * 60 + 5 * 60 + 30, 0],
    ]);
  });

  it("flags unmatched punches instead of guessing; today's open clock-in is not an issue", () => {
    const days = timesheet(
      [
        { kind: "IN", at: at("2026-11-01T06:00:00Z") },
        { kind: "IN", at: at("2026-11-02T06:00:00Z") },
        { kind: "OUT", at: at("2026-11-02T14:00:00Z") },
        { kind: "OUT", at: at("2026-11-02T15:00:00Z") },
        { kind: "IN", at: at("2026-11-03T06:00:00Z") },
      ],
      TZ,
      at("2026-11-03T09:00:00Z"),
    );
    expect(days.map((d) => [d.day, d.minutes, d.issues])).toEqual([
      ["2026-11-01", 0, 1],
      ["2026-11-02", 480, 1],
      ["2026-11-03", 0, 0],
    ]);
    expect(days[1].sessions.map((s) => s.issue)).toEqual([null, "MISSING_IN"]);
  });
});
