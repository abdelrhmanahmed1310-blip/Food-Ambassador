import type { AllergenCode } from "./allergens";
import type { Basis, Nutrient } from "./rules";

/**
 * Parsers for the published formats of three public food databases
 * (DECISIONS.md ADR-041). Pure. They copy what the source states and say
 * how a value was chosen; they never fill a gap, convert one nutrient into
 * another (e.g. sodium into salt) or read allergens from ingredient text.
 */

export const LIBRARY_SOURCES = ["USDA_FDC", "OPEN_FOOD_FACTS", "WIKIDATA"] as const;
export type LibrarySource = (typeof LIBRARY_SOURCES)[number];

export interface ParsedFood {
  sourceId: string;
  dataType: string | null;
  name: string;
  nameAr: string | null;
  description: string | null;
  brand: string | null;
  basis: Basis | null;
  values: Partial<Record<Nutrient, string>>;
  allergens: AllergenCode[];
  traces: AllergenCode[];
  unmappedTags: string[];
  notes: string[];
  sourceUrl: string;
}

export interface ParseResult {
  foods: ParsedFood[];
  problems: Array<{ index: number; reason: string }>;
}

export const SOURCE_TERMS: Record<LibrarySource, { licence: string; attribution: string }> = {
  USDA_FDC: {
    licence: "CC0 1.0 (public domain)",
    attribution:
      "U.S. Department of Agriculture, Agricultural Research Service. FoodData Central (fdc.nal.usda.gov)",
  },
  OPEN_FOOD_FACTS: {
    licence: "Open Database License (ODbL) 1.0; contents DbCL 1.0",
    attribution: "Open Food Facts contributors (openfoodfacts.org)",
  },
  WIKIDATA: {
    licence: "CC0 1.0 (public domain)",
    attribution: "Wikidata (wikidata.org)",
  },
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 500): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** A finite non-negative number from JSON, as an exact decimal string (at most 4 places). */
function amount(v: unknown): string | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())
        ? Number(v)
        : NaN;
  if (!Number.isFinite(n) || n < 0 || n >= 1e8) return null;
  const s = typeof v === "string" ? v.trim() : String(n);
  if (/e/i.test(s)) return null;
  const [int, frac = ""] = s.split(".");
  if (frac.length <= 4) return frac ? `${int}.${frac}` : int;
  // Round half up to 4 places on the decimal string itself.
  const scaled = BigInt(int + frac.slice(0, 4)) + (Number(frac[4]) >= 5 ? BigInt(1) : BigInt(0));
  const digits = scaled.toString().padStart(5, "0");
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`.replace(/\.?0+$/, "") || "0";
}

/** Divide a decimal string by 1000 exactly (mg → g). */
function milliToUnit(v: string): string {
  const [int, frac = ""] = v.split(".");
  const padded = int.padStart(4, "0");
  const whole = padded.slice(0, -3).replace(/^0+(?=\d)/, "");
  const out = `${whole}.${padded.slice(-3)}${frac}`.replace(/\.?0+$/, "");
  return amount(out) ?? "0";
}

// ─── USDA FoodData Central ───

/** FDC nutrient numbers (SR legacy numbering, as used in FDC downloads and the API). */
const FDC_NUTRIENTS: Array<{ number: string; nutrient: Nutrient; unit: string; note?: string }> = [
  { number: "208", nutrient: "energyKcal", unit: "kcal" },
  {
    number: "958",
    nutrient: "energyKcal",
    unit: "kcal",
    note: "energy: Atwater specific factors (no general energy figure)",
  },
  {
    number: "957",
    nutrient: "energyKcal",
    unit: "kcal",
    note: "energy: Atwater general factors (no general energy figure)",
  },
  { number: "268", nutrient: "energyKj", unit: "kj" },
  { number: "204", nutrient: "fat", unit: "g" },
  { number: "606", nutrient: "saturatedFat", unit: "g" },
  { number: "205", nutrient: "carbohydrate", unit: "g" },
  {
    number: "205.2",
    nutrient: "carbohydrate",
    unit: "g",
    note: "carbohydrate: by summation (no carbohydrate by difference)",
  },
  { number: "269", nutrient: "sugars", unit: "g" },
  { number: "269.3", nutrient: "sugars", unit: "g", note: "sugars: total sugars (269.3)" },
  { number: "291", nutrient: "fibre", unit: "g" },
  { number: "203", nutrient: "protein", unit: "g" },
  { number: "307", nutrient: "sodium", unit: "mg" },
];

function fdcNutrients(list: unknown): Map<string, { unit: string; value: string }> {
  const out = new Map<string, { unit: string; value: string }>();
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (!isObject(raw)) continue;
    // Download format {nutrient: {number, unitName}, amount}; search API {nutrientNumber, unitName, value};
    // abridged {number, unitName, amount}.
    const nested = isObject(raw.nutrient) ? raw.nutrient : null;
    const number = text(nested?.number ?? raw.nutrientNumber ?? raw.number, 20);
    const unit = text(nested?.unitName ?? raw.unitName, 20)?.toLowerCase();
    const value = amount(raw.amount ?? raw.value);
    if (number && unit && value !== null && !out.has(number)) out.set(number, { unit, value });
  }
  return out;
}

export function parseUsdaFdc(data: unknown): ParseResult {
  const list: unknown[] = Array.isArray(data)
    ? data
    : isObject(data)
      ? ((["FoundationFoods", "SRLegacyFoods", "SurveyFoods", "BrandedFoods", "foods"]
          .map((k) => data[k])
          .find(Array.isArray) as unknown[] | undefined) ??
        (data.fdcId !== undefined ? [data] : []))
      : [];
  const result: ParseResult = { foods: [], problems: [] };
  if (list.length === 0) result.problems.push({ index: -1, reason: "noFoods" });
  list.forEach((raw, index) => {
    if (!isObject(raw)) return result.problems.push({ index, reason: "notAnObject" });
    const fdcId =
      typeof raw.fdcId === "number" || typeof raw.fdcId === "string" ? String(raw.fdcId) : null;
    const name = text(raw.description, 300);
    if (!fdcId || !/^\d{1,10}$/.test(fdcId) || !name)
      return result.problems.push({ index, reason: "missingIdOrName" });
    const nutrients = fdcNutrients(raw.foodNutrients);
    const values: ParsedFood["values"] = {};
    const notes: string[] = [];
    for (const def of FDC_NUTRIENTS) {
      if (values[def.nutrient] !== undefined) continue;
      const n = nutrients.get(def.number);
      if (!n) continue;
      if (n.unit !== def.unit) {
        notes.push(`nutrient ${def.number} in ${n.unit}, expected ${def.unit}: not used`);
        continue;
      }
      values[def.nutrient] = def.unit === "mg" ? milliToUnit(n.value) : n.value;
      if (def.note) notes.push(def.note);
    }
    const dataType = text(raw.dataType, 60);
    const servingUnit = text(raw.servingSizeUnit, 20)?.toLowerCase();
    const basis: Basis = dataType === "Branded" && servingUnit === "ml" ? "PER_100ML" : "PER_100G";
    if (Object.keys(values).length === 0) notes.push("no nutrient values in the record");
    result.foods.push({
      sourceId: fdcId,
      dataType,
      name,
      nameAr: null,
      description: text(
        raw.foodCategory && isObject(raw.foodCategory)
          ? raw.foodCategory.description
          : raw.foodCategory,
        200,
      ),
      brand: text(raw.brandOwner ?? raw.brandName, 200),
      basis,
      values,
      allergens: [],
      traces: [],
      unmappedTags: [],
      notes,
      sourceUrl: `https://fdc.nal.usda.gov/food-details/${fdcId}/nutrients`,
    });
  });
  return result;
}

// ─── Open Food Facts ───

export const OFF_ALLERGEN_TAGS: Record<string, AllergenCode> = {
  "en:gluten": "GLUTEN",
  "en:crustaceans": "CRUSTACEANS",
  "en:eggs": "EGGS",
  "en:fish": "FISH",
  "en:peanuts": "PEANUTS",
  "en:soybeans": "SOY",
  "en:milk": "MILK",
  "en:nuts": "TREE_NUTS",
  "en:celery": "CELERY",
  "en:mustard": "MUSTARD",
  "en:sesame-seeds": "SESAME",
  "en:sulphur-dioxide-and-sulphites": "SULPHITES",
  "en:lupin": "LUPIN",
  "en:molluscs": "MOLLUSCS",
};

const OFF_NUTRIENTS: Array<[string, Nutrient]> = [
  ["energy-kcal_100g", "energyKcal"],
  ["energy-kj_100g", "energyKj"],
  ["fat_100g", "fat"],
  ["saturated-fat_100g", "saturatedFat"],
  ["carbohydrates_100g", "carbohydrate"],
  ["sugars_100g", "sugars"],
  ["fiber_100g", "fibre"],
  ["proteins_100g", "protein"],
  ["salt_100g", "salt"],
  ["sodium_100g", "sodium"],
];

function offTags(v: unknown) {
  const codes = new Set<AllergenCode>();
  const unmapped: string[] = [];
  if (Array.isArray(v))
    for (const tag of v) {
      if (typeof tag !== "string") continue;
      const code = OFF_ALLERGEN_TAGS[tag];
      if (code) codes.add(code);
      else unmapped.push(tag.slice(0, 80));
    }
  return { codes: [...codes], unmapped };
}

/** Open Food Facts JSON: one API product, a search page, an array, or JSON Lines from the dump. */
export function parseOpenFoodFacts(input: string): ParseResult {
  let items: unknown[];
  try {
    const data: unknown = JSON.parse(input);
    items = Array.isArray(data)
      ? data
      : isObject(data) && Array.isArray(data.products)
        ? data.products
        : [data];
  } catch {
    items = [];
    for (const line of input.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        items.push(JSON.parse(line));
      } catch {
        items.push(null);
      }
    }
  }
  const result: ParseResult = { foods: [], problems: [] };
  if (items.length === 0) result.problems.push({ index: -1, reason: "noFoods" });
  items.forEach((raw, index) => {
    if (!isObject(raw)) return result.problems.push({ index, reason: "notAnObject" });
    const product = isObject(raw.product) ? raw.product : raw;
    const code = text(raw.code ?? product.code ?? product._id, 30);
    if (!code || !/^\d{6,14}$/.test(code))
      return result.problems.push({ index, reason: "missingBarcode" });
    const name = text(product.product_name_en, 300) ?? text(product.product_name, 300);
    if (!name) return result.problems.push({ index, reason: "missingIdOrName" });
    const notes: string[] = [];
    const values: ParsedFood["values"] = {};
    const nutriments = isObject(product.nutriments) ? product.nutriments : {};
    if (product.no_nutrition_data === "on")
      notes.push("the product page says it has no nutrition data");
    else
      for (const [key, nutrient] of OFF_NUTRIENTS) {
        const v = amount(nutriments[key]);
        if (v !== null) values[nutrient] = v;
      }
    if (Object.keys(values).length === 0) notes.push("no per-100 values in the record");
    const unit = text(product.product_quantity_unit, 10)?.toLowerCase();
    const quantity = text(product.quantity, 50)?.toLowerCase() ?? "";
    const liquid = unit === "ml" || (!unit && /\d\s*(ml|cl|l)\b/.test(quantity));
    if (!unit && !liquid) notes.push("per 100 g: the record does not give its quantity unit");
    const allergens = offTags(product.allergens_tags);
    const traces = offTags(product.traces_tags);
    if (allergens.codes.length + traces.codes.length === 0)
      notes.push("no allergens listed — this does not mean free from");
    result.foods.push({
      sourceId: code,
      dataType: null,
      name,
      nameAr: text(product.product_name_ar, 300),
      description: text(product.generic_name, 300),
      brand: text(product.brands, 200),
      basis: Object.keys(values).length > 0 ? (liquid ? "PER_100ML" : "PER_100G") : null,
      values,
      allergens: allergens.codes,
      traces: traces.codes.filter((c) => !allergens.codes.includes(c)),
      unmappedTags: [...allergens.unmapped, ...traces.unmapped],
      notes,
      sourceUrl: `https://world.openfoodfacts.org/product/${code}`,
    });
  });
  return result;
}

// ─── Wikidata ───

/** Entity JSON from Special:EntityData or wbgetentities: names in English and Arabic. */
export function parseWikidata(data: unknown): ParseResult {
  const entities = isObject(data) && isObject(data.entities) ? Object.values(data.entities) : [];
  const result: ParseResult = { foods: [], problems: [] };
  if (entities.length === 0) result.problems.push({ index: -1, reason: "noFoods" });
  entities.forEach((raw, index) => {
    if (!isObject(raw)) return result.problems.push({ index, reason: "notAnObject" });
    const id = text(raw.id, 20);
    const label = (lang: string) => {
      const labels = isObject(raw.labels) ? raw.labels : {};
      const l = labels[lang];
      return isObject(l) ? text(l.value, 300) : null;
    };
    const description =
      isObject(raw.descriptions) && isObject(raw.descriptions.en)
        ? text(raw.descriptions.en.value, 300)
        : null;
    const name = label("en") ?? label("ar");
    if (!id || !/^Q\d{1,12}$/.test(id) || !name)
      return result.problems.push({ index, reason: "missingIdOrName" });
    result.foods.push({
      sourceId: id,
      dataType: null,
      name,
      nameAr: label("ar"),
      description,
      brand: null,
      basis: null,
      values: {},
      allergens: [],
      traces: [],
      unmappedTags: [],
      notes: label("ar") ? [] : ["no Arabic label"],
      sourceUrl: `https://www.wikidata.org/wiki/${id}`,
    });
  });
  return result;
}

export function parseLibraryFile(source: LibrarySource, content: string): ParseResult {
  if (source === "OPEN_FOOD_FACTS") return parseOpenFoodFacts(content);
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return { foods: [], problems: [{ index: -1, reason: "notJson" }] };
  }
  return source === "USDA_FDC" ? parseUsdaFdc(data) : parseWikidata(data);
}
