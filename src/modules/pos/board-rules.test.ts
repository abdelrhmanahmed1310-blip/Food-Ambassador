import { describe, expect, it } from "vitest";
import { clockIn, inWindow, paginate } from "./board-rules";

describe("menu board rules (ADR-133)", () => {
  it("shows a category only inside its hours, also across midnight", () => {
    expect(inWindow("09:30", "06:00", "11:00")).toBe(true);
    expect(inWindow("11:00", "06:00", "11:00")).toBe(false);
    expect(inWindow("05:59", "06:00", "11:00")).toBe(false);
    expect(inWindow("23:00", "22:00", "02:00")).toBe(true);
    expect(inWindow("01:59", "22:00", "02:00")).toBe(true);
    expect(inWindow("12:00", "22:00", "02:00")).toBe(false);
    expect(inWindow("12:00", null, null)).toBe(true);
  });
  it("reads the clock in the branch's time zone", () => {
    const at = new Date("2026-11-10T05:30:00Z");
    expect(clockIn("Asia/Riyadh", at)).toBe("08:30");
    expect(clockIn("Africa/Cairo", at)).toBe("07:30");
  });
  it("pages items, keeping categories together where they fit", () => {
    const item = (c: string, n: number) => ({ id: `${c}${n}`, category: { id: c } });
    const items = [
      item("a", 1),
      item("a", 2),
      item("b", 1),
      item("b", 2),
      item("b", 3),
      item("c", 1),
    ];
    expect(paginate(items, 0)).toHaveLength(1);
    expect(paginate(items, 4).map((p) => p.map((i) => i.id))).toEqual([
      ["a1", "a2"],
      ["b1", "b2", "b3", "c1"],
    ]);
    // A category larger than a page is split; the rest shares a page with the next one.
    expect(paginate(items, 2).map((p) => p.map((i) => i.id))).toEqual([
      ["a1", "a2"],
      ["b1", "b2"],
      ["b3", "c1"],
    ]);
  });
});
