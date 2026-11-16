import { describe, expect, it } from "vitest";
import { matchTerms, parseReference } from "./reference-match";

describe("product to library matching (ADR-136)", () => {
  it("keeps the food words of a product name, not pack sizes", () => {
    expect(matchTerms("Rice basmati 5kg bag")).toBe("rice basmati");
    expect(matchTerms("Olive oil, extra virgin (1 L)")).toBe("olive oil extra virgin");
    expect(matchTerms("Tomato paste 400 g x 12 tin")).toBe("tomato paste");
    expect(matchTerms("أرز بسمتي 5 كجم")).toBe("أرز بسمتي");
    expect(matchTerms("500ML")).toBe("");
  });

  it("reads a reference source and id, with aliases, or reports the column", () => {
    expect(parseReference("", "")).toEqual({ ok: true, ref: null });
    expect(parseReference("usda", "171287")).toEqual({
      ok: true,
      ref: { source: "USDA_FDC", sourceId: "171287" },
    });
    expect(parseReference("Open Food Facts", "6281000000014")).toMatchObject({
      ref: { source: "OPEN_FOOD_FACTS" },
    });
    expect(parseReference("wikidata", "q42")).toMatchObject({ ref: { sourceId: "Q42" } });
    expect(parseReference("library", "M-0190c2a1-7b3c")).toMatchObject({
      ref: { source: "MANUAL" },
    });
    expect(parseReference("USDA", "")).toEqual({
      ok: false,
      column: "reference_id",
      problem: "referenceIncomplete",
    });
    expect(parseReference("", "171287")).toMatchObject({ column: "reference_source" });
    expect(parseReference("nutritionix", "1")).toMatchObject({
      problem: "referenceSourceUnknown",
    });
    expect(parseReference("USDA", "abc")).toMatchObject({ problem: "referenceIdInvalid" });
    expect(parseReference("OFF", "123")).toMatchObject({ problem: "referenceIdInvalid" });
  });
});
