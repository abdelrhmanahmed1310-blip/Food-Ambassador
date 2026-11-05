import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  assignSessions,
  basisDaysFor,
  compareShift,
  overtimePay,
  paidMinutes,
  shiftWindow,
  weekDays,
  weekStart,
} from "./rules";

const at = (s: string) => new Date(s);
const RUH = "Asia/Riyadh"; // UTC+3

describe("shift windows (ADR-128)", () => {
  it("places shifts in the branch's time, past midnight too", () => {
    expect(shiftWindow("2026-11-05", "09:00", "17:00", RUH)).toEqual({
      startsAt: at("2026-11-05T06:00:00Z"),
      endsAt: at("2026-11-05T14:00:00Z"),
    });
    const night = shiftWindow("2026-11-05", "22:00", "06:00", RUH);
    expect(night.endsAt).toEqual(at("2026-11-06T03:00:00Z"));
    expect(paidMinutes(night.startsAt, night.endsAt, 30)).toBe(450);
  });

  it("finds the week's Monday", () => {
    expect(weekStart("2026-11-05")).toBe("2026-11-02"); // a Thursday
    expect(weekStart("2026-11-02")).toBe("2026-11-02");
    expect(weekStart("2026-11-08")).toBe("2026-11-02"); // Sunday
    expect(weekDays("2026-11-02")).toHaveLength(7);
  });
});

describe("compareShift (ADR-128)", () => {
  const shift = { ...shiftWindow("2026-11-05", "09:00", "17:00", RUH), breakMinutes: 60 };
  const base = {
    ...shift,
    graceMinutes: 5,
    overtimeMinimumMinutes: 15,
    now: at("2026-11-06T00:00:00Z"),
  };
  const session = (i: string, o: string | null, issue: string | null = null) => {
    const a = at(i);
    const b = o ? at(o) : null;
    return {
      in: a,
      out: b,
      minutes: b ? Math.round((b.getTime() - a.getTime()) / 60000) : 0,
      issue,
    };
  };

  it("is on time within the grace minutes", () => {
    const r = compareShift({
      ...base,
      sessions: [session("2026-11-05T06:04:00Z", "2026-11-05T14:00:00Z")],
    });
    expect([r.outcome, r.lateMinutes, r.workedMinutes, r.overtimeMinutes]).toEqual([
      "ON_TIME",
      0,
      416,
      0,
    ]);
  });

  it("flags lateness, leaving early and overtime beyond the minimum", () => {
    const late = compareShift({
      ...base,
      sessions: [session("2026-11-05T06:20:00Z", "2026-11-05T13:30:00Z")],
    });
    expect([late.outcome, late.lateMinutes, late.earlyMinutes]).toEqual(["EXCEPTION", 20, 30]);
    const long = compareShift({
      ...base,
      sessions: [session("2026-11-05T06:00:00Z", "2026-11-05T15:10:00Z")],
    });
    expect([long.outcome, long.overtimeMinutes]).toEqual(["ON_TIME", 70]);
    const bit = compareShift({
      ...base,
      sessions: [session("2026-11-05T06:00:00Z", "2026-11-05T14:10:00Z")],
    });
    expect(bit.overtimeMinutes).toBe(0); // 10 minutes is under the 15-minute minimum
  });

  it("adds split sessions, and never guesses a missing punch", () => {
    const split = compareShift({
      ...base,
      sessions: [
        session("2026-11-05T06:00:00Z", "2026-11-05T09:00:00Z"),
        session("2026-11-05T10:00:00Z", "2026-11-05T14:00:00Z"),
      ],
    });
    expect([split.workedMinutes, split.sessions]).toEqual([360, [0, 1]]);
    expect(
      compareShift({ ...base, sessions: [session("2026-11-05T06:00:00Z", null, "MISSING_OUT")] })
        .outcome,
    ).toBe("INCOMPLETE");
  });

  it("is upcoming, in progress or a no-show by the time", () => {
    expect(compareShift({ ...base, now: at("2026-11-05T05:00:00Z"), sessions: [] }).outcome).toBe(
      "UPCOMING",
    );
    expect(compareShift({ ...base, now: at("2026-11-05T08:00:00Z"), sessions: [] }).outcome).toBe(
      "IN_PROGRESS",
    );
    expect(compareShift({ ...base, sessions: [] }).outcome).toBe("NO_SHOW");
    // A session far from the shift is not taken.
    expect(
      compareShift({ ...base, sessions: [session("2026-11-05T19:00:00Z", "2026-11-05T21:00:00Z")] })
        .outcome,
    ).toBe("NO_SHOW");
  });
});

describe("overtimePay (ADR-128)", () => {
  it("pays the entered multiplier on an hourly rate of monthly pay", () => {
    // 6000 / (30 × 8) = 25 an hour; × 1.5 × 70 minutes = 43.75 (test values).
    expect(
      overtimePay({
        minutes: 70,
        monthlyBase: new Decimal(6000),
        basisDays: 30,
        dailyHours: new Decimal(8),
        multiplier: new Decimal("1.5"),
        currency: "SAR",
      }).toFixed(),
    ).toBe("43.75");
  });
});

describe("assignSessions (ADR-128)", () => {
  it("gives each session to one shift, the one it overlaps most", () => {
    const lunch = shiftWindow("2026-11-05", "11:00", "15:00", RUH);
    const dinner = shiftWindow("2026-11-05", "17:00", "23:00", RUH);
    const s = (i: string, o: string) => ({ in: at(i), out: at(o), minutes: 0, issue: null });
    expect(
      assignSessions(
        [lunch, dinner],
        [
          s("2026-11-05T07:55:00Z", "2026-11-05T12:30:00Z"), // 10:55–15:30
          s("2026-11-05T13:50:00Z", "2026-11-05T20:00:00Z"), // 16:50–23:00
          s("2026-11-04T08:00:00Z", "2026-11-04T09:00:00Z"), // the day before
        ],
      ),
    ).toEqual([[0], [1]]);
  });

  it("divides a month by 30 or its own length", () => {
    expect([
      basisDaysFor("THIRTY_DAYS", "2026-02-10"),
      basisDaysFor("CALENDAR_DAYS", "2026-02-10"),
    ]).toEqual([30, 28]);
  });
});
