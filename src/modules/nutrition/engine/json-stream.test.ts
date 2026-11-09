import { describe, expect, it } from "vitest";
import { jsonRecords } from "./json-stream";

/** Records out of large JSON files, chunk by chunk (ADR-132). */
async function* chunks(text: string, size: number) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}
const all = async (text: string, size = 7) => {
  const out: unknown[] = [];
  for await (const r of jsonRecords(chunks(text, size))) out.push(r);
  return out;
};

describe("jsonRecords (ADR-132)", () => {
  const foods = [
    {
      fdcId: 1,
      description: 'Bread, "white" {sliced}',
      foodNutrients: [{ amount: 1 }, { amount: 2 }],
    },
    { fdcId: 2, description: "Back\\slash ] and [", foodPortions: [] },
  ];
  it("reads an FDC download's wrapped array whatever the chunk size", async () => {
    const text = JSON.stringify({ BrandedFoods: foods }, null, 1);
    for (const size of [1, 3, 7, 64, 100000]) expect(await all(text, size)).toEqual(foods);
  });
  it("reads a bare array and JSON Lines", async () => {
    expect(await all(JSON.stringify(foods))).toEqual(foods);
    expect(await all(foods.map((f) => JSON.stringify(f)).join("\n") + "\n")).toEqual(foods);
    expect(await all(JSON.stringify(foods[0]))).toEqual([foods[0]]);
  });
  it("stops at a truncated file", async () => {
    const text = JSON.stringify({ SurveyFoods: foods }).slice(0, 60);
    await expect(all(text)).rejects.toThrow(/middle of a record/);
  });
});
