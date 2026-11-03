import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  groupSpend,
  previousPeriod,
  priceChanges,
  topShare,
  type ReceivedRow,
  type ReturnedRow,
} from "./spend-rules";

const d = (v: string) => new Decimal(v);
const rec = (o: Omit<Partial<ReceivedRow>, "value"> & { value: string }): ReceivedRow => ({
  supplierId: "s1",
  productId: "p1",
  categoryId: null,
  branchId: "b1",
  month: "2026-11",
  variance: d("0"),
  quantityBase: d("1"),
  ...o,
  value: d(o.value),
});
const ret = (o: Omit<Partial<ReturnedRow>, "value"> & { value: string }): ReturnedRow => ({
  supplierId: "s1",
  productId: "p1",
  categoryId: null,
  branchId: "b1",
  month: "2026-11",
  ...o,
  value: d(o.value),
});

describe("groupSpend", () => {
  it("nets returns, counts suppliers and shares, largest first", () => {
    const groups = groupSpend(
      [
        rec({ value: "600", variance: d("20") }),
        rec({ value: "100", supplierId: "s2", categoryId: "c1" }),
        rec({ value: "300", supplierId: "s2", categoryId: "c1", variance: d("-5") }),
      ],
      [ret({ value: "200" })],
      (r) => r.supplierId,
    );
    expect(groups.map((g) => [g.key, g.net.toFixed(), g.share?.toFixed(), g.lines])).toEqual([
      ["s1", "400", "0.5", 1],
      ["s2", "400", "0.5", 2],
    ]);
    expect(groups[0].returned.toFixed()).toBe("200");
    expect(groups[0].variance.toFixed()).toBe("20");
    const byCategory = groupSpend(
      [
        rec({ value: "1" }),
        rec({ value: "1", supplierId: "s2" }),
        rec({ value: "5", categoryId: "c1" }),
      ],
      [],
      (r) => r.categoryId,
    );
    expect(byCategory.map((g) => [g.key, g.suppliers])).toEqual([
      ["c1", 1],
      [null, 2],
    ]);
  });

  it("has no shares when nothing was spent", () => {
    const g = groupSpend([rec({ value: "100" })], [ret({ value: "100" })], () => "x");
    expect(g[0].share).toBeNull();
    expect(topShare(g, 1)).toBeNull();
  });

  it("measures concentration", () => {
    const g = groupSpend(
      [
        rec({ value: "70" }),
        rec({ value: "20", supplierId: "s2" }),
        rec({ value: "10", supplierId: "s3" }),
      ],
      [],
      (r) => r.supplierId,
    );
    expect(topShare(g, 2)!.toFixed()).toBe("0.9");
  });
});

describe("priceChanges", () => {
  it("compares average prices per base unit for products bought in both periods", () => {
    const now = [
      rec({ value: "110", quantityBase: d("10") }),
      rec({ value: "120", quantityBase: d("10") }), // avg 11.5
      rec({ value: "50", productId: "p2", quantityBase: d("5") }), // not bought before
    ];
    const before = [rec({ value: "100", quantityBase: d("10") })]; // avg 10
    const [c] = priceChanges(now, before);
    expect(priceChanges(now, before)).toHaveLength(1);
    expect([c.before.toFixed(), c.now.toFixed(), c.change!.toFixed(), c.impact.toFixed()]).toEqual([
      "10",
      "11.5",
      "0.15",
      "30",
    ]);
  });
});

describe("previousPeriod", () => {
  it("is the same length, just before", () => {
    expect(previousPeriod("2026-11-01", "2026-11-30")).toEqual({
      from: "2026-10-02",
      to: "2026-10-31",
    });
    expect(previousPeriod("2026-03-01", "2026-03-01")).toEqual({
      from: "2026-02-28",
      to: "2026-02-28",
    });
  });
});
