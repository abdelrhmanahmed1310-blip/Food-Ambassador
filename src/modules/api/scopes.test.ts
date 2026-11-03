import { describe, expect, it } from "vitest";
import { pageLimit, parseApiKey, permissionsOf } from "./scopes";

describe("REST API scopes and keys (ADR-090)", () => {
  it("maps scopes to read permissions only, ignoring unknown ones", () => {
    expect(permissionsOf(["sales:read", "stock:read", "admin:write"]).sort()).toEqual([
      "b2b.view",
      "inventory.view",
      "pos.view",
    ]);
  });

  it("reads a bearer key and refuses anything else", () => {
    const key = `fa_ABCdef123456_${"x".repeat(43)}`;
    expect(parseApiKey(`Bearer ${key}`)).toEqual({
      prefix: "ABCdef123456",
      secret: "x".repeat(43),
    });
    expect(parseApiKey(key)).toBeNull(); // no "Bearer"
    expect(parseApiKey("Bearer fa_short_x")).toBeNull();
    expect(parseApiKey(null)).toBeNull();
  });

  it("bounds the page size", () => {
    expect([
      pageLimit(null),
      pageLimit("10"),
      pageLimit("1000"),
      pageLimit("-1"),
      pageLimit("x"),
    ]).toEqual([50, 10, 200, 50, 50]);
  });
});
