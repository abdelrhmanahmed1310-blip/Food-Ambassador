import { describe, expect, it } from "vitest";
import { slugify, withRandomSuffix } from "./slug";

describe("slugify", () => {
  it("lower-cases and hyphenates", () => {
    expect(slugify("Nile Bistro & Café")).toBe("nile-bistro-cafe");
  });

  it("trims separators and length", () => {
    expect(slugify("  --Hello--  ")).toBe("hello");
    expect(slugify("a".repeat(60)).length).toBe(40);
  });

  it("falls back for names without Latin characters", () => {
    expect(slugify("مطعم النيل")).toBe("org");
    expect(slugify("!!!")).toBe("org");
  });

  it("produces slugs accepted by the database constraint", () => {
    for (const name of ["Nile Bistro", "مطعم", "x-", "A   B", "Ünïcödé Kitchen 2"]) {
      expect(slugify(name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe("withRandomSuffix", () => {
  it("appends a 4-character base-36 suffix", () => {
    expect(withRandomSuffix("nile", () => 0)).toBe("nile-0000");
    expect(withRandomSuffix("nile")).toMatch(/^nile-[a-z0-9]{4}$/);
  });
});
