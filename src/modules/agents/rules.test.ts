import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { dailyCloseFindings, readSettings, type BranchDay } from "./rules";

const d = (v: string) => new Decimal(v);
const day = (over: Partial<BranchDay> = {}): BranchDay => ({
  branchId: "b1",
  code: "RUH",
  registers: 1,
  orders: 10,
  sales: d("1000"),
  voids: 0,
  voidAmount: d("0"),
  refunds: 0,
  refundAmount: d("0"),
  salesWeekAgo: d("1000"),
  shiftsLeftOpen: [],
  cashDifferences: [],
  shortfalls: 0,
  ...over,
});
const settings = readSettings("DAILY_CLOSE", {});

describe("daily close checks (ADR-140)", () => {
  it("reports nothing for a clean day", () => {
    expect(dailyCloseFindings([day()], settings)).toEqual([]);
  });

  it("reports what needs a look, worst first", () => {
    const f = dailyCloseFindings(
      [
        day({
          voids: 2,
          voidAmount: d("100"),
          refunds: 1,
          refundAmount: d("20"),
          sales: d("600"),
          shiftsLeftOpen: [{ register: "TILL1", openedOn: "2026-11-22" }],
          cashDifferences: [
            { register: "TILL1", shift: "SHF-1", difference: d("-15.5") },
            { register: "TILL2", shift: "SHF-2", difference: d("0") },
          ],
          shortfalls: 3,
        }),
      ],
      settings,
    );
    expect(f.map((x) => `${x.severity}:${x.code}`)).toEqual([
      "CRITICAL:SHIFT_LEFT_OPEN",
      "WARNING:CASH_SHORT",
      "WARNING:VOIDS",
      "WARNING:SALES_DROP",
      "WARNING:SHORTFALLS",
      "INFO:REFUNDS",
    ]);
    expect(f.find((x) => x.code === "CASH_SHORT")?.params.amount).toBe("15.50");
    // 100 voided of 700 rung up = 14.3 %, above the 5 % alert.
    expect(f.find((x) => x.code === "VOIDS")?.params.percent).toBe("14.3");
    expect(f.find((x) => x.code === "SALES_DROP")?.params.percent).toBe("40.0");
  });

  it("respects the tolerances and never compares with a missing week", () => {
    const s = readSettings("DAILY_CLOSE", {
      cashTolerance: "20",
      voidAlertPercent: 20,
      salesDropPercent: 50,
    });
    const f = dailyCloseFindings(
      [
        day({
          voids: 1,
          voidAmount: d("10"),
          sales: d("600"),
          cashDifferences: [{ register: "T", shift: "S", difference: d("15") }],
        }),
        day({ branchId: "b2", code: "JED", salesWeekAgo: null, sales: d("1") }),
        day({ branchId: "b3", code: "DMM", orders: 0, sales: d("0") }),
      ],
      s,
    );
    expect(f.map((x) => `${x.code}:${x.params.branch}`)).toEqual(["NO_SALES:DMM", "VOIDS:RUH"]);
    expect(f.find((x) => x.code === "VOIDS")?.severity).toBe("INFO");
  });

  it("falls back to defaults for stored settings that are not valid", () => {
    expect(readSettings("REPLENISHMENT", { basis: "GUESS" })).toEqual({
      investigateCritical: false,
      warehouseIds: [],
      basis: "MIN_MAX",
      // Acting within limits is off until amounts are set (ADR-145).
      maxOrderAmount: "0",
      maxDailyAmount: "0",
      holdHours: 4,
    });
    expect(readSettings("DAILY_CLOSE", null).salesDropPercent).toBe(30);
  });
});
