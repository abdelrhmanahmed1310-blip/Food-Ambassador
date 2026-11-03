import { describe, expect, it } from "vitest";
import { normalizeQuery } from "./rules";

describe("search query (ADR-088)", () => {
  it("trims, collapses spaces and refuses too short or too long text", () => {
    expect(normalizeQuery("  olive   oil ")).toEqual({ text: "olive oil", digits: null });
    expect(normalizeQuery("a")).toBeNull();
    expect(normalizeQuery("x".repeat(81))).toBeNull();
    expect(normalizeQuery(undefined)).toBeNull();
    expect(normalizeQuery(["po"])).toBeNull();
  });

  it("reads a phone number written with spaces, dashes or a plus", () => {
    expect(normalizeQuery("+966 50-123 4567")?.digits).toBe("966501234567");
    expect(normalizeQuery("PO-2026")?.digits).toBeNull();
    expect(normalizeQuery("123")?.digits).toBeNull(); // too few digits
  });

  it("keeps Arabic text as typed", () => {
    expect(normalizeQuery(" زيت زيتون ")?.text).toBe("زيت زيتون");
  });
});
