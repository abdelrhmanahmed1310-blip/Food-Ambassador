import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { dueDateFor, invoiceMatchStatus, matchGoodsLine, totalMatches } from "./rules";

const d = (v: string) => new Decimal(v);
const base = {
  openBase: d("10"),
  invoicedBase: d("10"),
  quantity: d("10"),
  invoicePrice: d("20"),
  orderPrice: d("20"),
  tolerance: d("0"),
};

describe("3-way match", () => {
  it("matches quantity and price", () => {
    expect(matchGoodsLine(base)).toMatchObject({ match: "MATCHED" });
    expect(matchGoodsLine({ ...base, invoicedBase: d("6"), quantity: d("6") }).match).toBe(
      "MATCHED",
    );
  });

  it("flags invoicing more than received and not yet invoiced", () => {
    const r = matchGoodsLine({ ...base, invoicedBase: d("12"), quantity: d("12") });
    expect(r.match).toBe("QUANTITY_VARIANCE");
    expect(r.quantityVariance.toFixed()).toBe("2");
  });

  it("allows price differences only within the tolerance", () => {
    const over = matchGoodsLine({ ...base, invoicePrice: d("21") });
    expect(over.match).toBe("PRICE_VARIANCE");
    expect(over.priceVariance.toFixed()).toBe("10");
    expect(matchGoodsLine({ ...base, invoicePrice: d("21"), tolerance: d("0.05") }).match).toBe(
      "MATCHED",
    );
    expect(matchGoodsLine({ ...base, invoicePrice: d("18.9"), tolerance: d("0.05") }).match).toBe(
      "PRICE_VARIANCE",
    );
    expect(matchGoodsLine({ ...base, invoicePrice: d("25"), invoicedBase: d("11") }).match).toBe(
      "PRICE_AND_QUANTITY",
    );
  });

  it("checks the printed total to the currency unit and works out due dates", () => {
    expect(totalMatches(d("115.00"), d("115.0000"), 2)).toBe(true);
    expect(totalMatches(d("115.01"), d("115"), 2)).toBe(false);
    expect(totalMatches(d("11.500"), d("11.5004"), 3)).toBe(true);
    expect(dueDateFor("2026-11-20", 30)).toBe("2026-12-20");
    expect(dueDateFor("2026-11-20", null)).toBeNull();
    expect(invoiceMatchStatus([{ match: "MATCHED" }, { match: "NOT_APPLICABLE" }], true)).toBe(
      "MATCHED",
    );
    expect(invoiceMatchStatus([{ match: "MATCHED" }], false)).toBe("EXCEPTION");
    expect(invoiceMatchStatus([{ match: "PRICE_VARIANCE" }], true)).toBe("EXCEPTION");
  });
});
