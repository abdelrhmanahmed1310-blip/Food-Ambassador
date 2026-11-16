/**
 * Pure rules for linking products to library foods (DECISIONS.md ADR-136):
 * the words of a product name worth matching on, and reading a reference
 * (source and id) from an upload.
 */

export type ReferenceSourceCode = "USDA_FDC" | "OPEN_FOOD_FACTS" | "WIKIDATA" | "MANUAL";

/** Pack sizes and pack words say nothing about the food: "Rice basmati 5kg bag" → "rice basmati". */
const PACK_WORDS = new Set([
  "kg",
  "g",
  "gm",
  "gr",
  "mg",
  "l",
  "lt",
  "ltr",
  "ml",
  "cl",
  "oz",
  "lb",
  "lbs",
  "pc",
  "pcs",
  "pack",
  "pk",
  "bag",
  "box",
  "case",
  "ctn",
  "carton",
  "can",
  "tin",
  "jar",
  "bottle",
  "btl",
  "sachet",
  "tray",
  "x",
  "each",
  "ea",
  "كجم",
  "كغ",
  "جم",
  "غ",
  "لتر",
  "مل",
  "كيس",
  "علبة",
  "كرتون",
  "عبوة",
  "حبة",
]);

export function matchTerms(name: string): string {
  return name
    .toLowerCase()
    .replace(/[()[\]{},.;:/\\|_+*"'!?#%&=-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/\d/.test(w) && !PACK_WORDS.has(w))
    .join(" ")
    .trim();
}

const SOURCE_ALIASES: Record<string, ReferenceSourceCode> = {
  USDA: "USDA_FDC",
  USDA_FDC: "USDA_FDC",
  FDC: "USDA_FDC",
  OFF: "OPEN_FOOD_FACTS",
  OPEN_FOOD_FACTS: "OPEN_FOOD_FACTS",
  OPENFOODFACTS: "OPEN_FOOD_FACTS",
  WIKIDATA: "WIKIDATA",
  MANUAL: "MANUAL",
  LIBRARY: "MANUAL",
  OWN: "MANUAL",
};

const ID_FORMAT: Record<ReferenceSourceCode, RegExp> = {
  USDA_FDC: /^\d{1,10}$/,
  OPEN_FOOD_FACTS: /^\d{6,14}$/,
  WIKIDATA: /^Q\d{1,12}$/,
  MANUAL: /^[A-Za-z0-9-]{1,40}$/,
};

/**
 * Read a reference from an upload row. Both empty: no reference. Problems are
 * translation keys: referenceSourceUnknown, referenceIdInvalid, referenceIncomplete.
 */
export function parseReference(
  rawSource: string | undefined,
  rawId: string | undefined,
):
  | { ok: true; ref: { source: ReferenceSourceCode; sourceId: string } | null }
  | { ok: false; column: "reference_source" | "reference_id"; problem: string } {
  const sourceText = (rawSource ?? "").trim();
  const id = (rawId ?? "").trim();
  if (!sourceText && !id) return { ok: true, ref: null };
  if (!sourceText || !id)
    return {
      ok: false,
      column: sourceText ? "reference_id" : "reference_source",
      problem: "referenceIncomplete",
    };
  const source = SOURCE_ALIASES[sourceText.toUpperCase().replace(/[\s-]+/g, "_")];
  if (!source) return { ok: false, column: "reference_source", problem: "referenceSourceUnknown" };
  const sourceId = source === "WIKIDATA" ? id.toUpperCase() : id;
  if (!ID_FORMAT[source].test(sourceId))
    return { ok: false, column: "reference_id", problem: "referenceIdInvalid" };
  return { ok: true, ref: { source, sourceId } };
}

export const referenceKey = (r: { source: string; sourceId: string }) =>
  `${r.source}:${r.sourceId}`;

/** Template for linking existing products in bulk (header only: ids come from the library or USDA). */
export const LINKS_TEMPLATE = "sku,reference_source,reference_id\r\n";
