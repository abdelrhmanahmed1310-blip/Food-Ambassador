import { createHash } from "node:crypto";
import { Decimal } from "@/lib/decimal";
import { parseUsdaFdc, type ParsedFood } from "../library-parsers";

/**
 * USDA FoodData Central normalization (DECISIONS.md ADR-132). Pure.
 *
 * Reads one food in any of the FDC shapes — the full format of the API
 * and the bulk downloads (Foundation, SR Legacy, Survey/FNDDS, Branded,
 * Experimental), the abridged format and a search result — into one
 * structure. Every nutrient keeps the source's id, number, amount and unit;
 * nothing missing is turned into zero, and nothing is borrowed from another
 * record. The ten summary values (ADR-041) come from the existing parser,
 * so their rules stay in one place.
 */

export type ValueStatus = "REPORTED" | "CALCULATED" | "BELOW_DETECTION" | "NOT_APPLICABLE";
export type IssueKind =
  | "MISSING_CORE_NUTRIENTS"
  | "IMPLAUSIBLE_VALUE"
  | "UNEXPECTED_UNIT"
  | "UNIT_MISMATCH"
  | "MISSING_SOURCE";

export interface SourceNutrient {
  usdaNutrientId: number | null;
  number: string | null;
  name: string;
  /** The source's unit, normalized to g, mg, µg, kcal, kJ or IU when recognised. */
  unit: string;
  amount: string | null;
  status: ValueStatus;
  derivationCode: string | null;
  derivationDescription: string | null;
  dataPoints: number | null;
}

export interface SourcePortion {
  sequence: number;
  amount: string | null;
  measure: string | null;
  description: string;
  gramWeight: string | null;
  millilitres: string | null;
}

export interface Issue {
  kind: IssueKind;
  detail: string;
  data?: Record<string, unknown>;
}

export interface NormalizedFood {
  source: "USDA_FDC";
  sourceId: string;
  dataType: string | null;
  name: string;
  brand: string | null;
  barcode: string | null;
  category: string | null;
  ingredientsText: string | null;
  publicationDate: string | null;
  basis: "PER_100G" | "PER_100ML";
  identifiers: Array<{ kind: "FDC_ID" | "GTIN_UPC" | "NDB_NUMBER" | "FOOD_CODE"; value: string }>;
  nutrients: SourceNutrient[];
  portions: SourcePortion[];
  /** The ten label values and notes, by the library rules (ADR-041). */
  summary: ParsedFood;
  issues: Issue[];
  sourceUrl: string;
  /** Stable hash of the payload, to apply each source version once. */
  payloadHash: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 500): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const num = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return new Decimal(v).toFixed();
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  return null;
};
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;

const UNITS: Record<string, string> = {
  g: "g",
  mg: "mg",
  ug: "µg",
  µg: "µg",
  mcg: "µg",
  kcal: "kcal",
  kj: "kJ",
  iu: "IU",
};
/** The source's unit in the app's spelling, or the source's own if unknown. */
export const normalUnit = (u: string) => UNITS[u.trim().toLowerCase()] ?? u.trim();
const KNOWN_UNITS = new Set(Object.values(UNITS));

/** A derivation that says the value is below a detection or quantification limit. */
const BELOW = /(below|less than)\b.*\b(limit|detection|quantification)|not detected|\bLO[DQ]\b/i;

/** Canonical JSON (sorted keys) for hashing. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}
export const payloadHash = (payload: unknown) =>
  createHash("sha256").update(canonical(payload)).digest("hex");

/** USDA dates come as "2019-04-01" or "4/1/2019". */
export function fdcDate(v: unknown): string | null {
  const s = str(v, 30);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

function nutrientsOf(list: unknown): SourceNutrient[] {
  if (!Array.isArray(list)) return [];
  const out: SourceNutrient[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!isObject(raw)) continue;
    // Full: {nutrient: {id, number, name, unitName}, amount, derivation: {code, description}, dataPoints}
    // Abridged: {number, name, amount, unitName, derivationCode}; search: {nutrientId, nutrientNumber, nutrientName, unitName, value}
    const n = isObject(raw.nutrient) ? raw.nutrient : null;
    const id = int(n?.id ?? raw.nutrientId);
    const number = str(n?.number ?? raw.nutrientNumber ?? raw.number, 20);
    const name = str(n?.name ?? raw.nutrientName ?? raw.name, 200);
    const unitRaw = str(n?.unitName ?? raw.unitName, 20);
    if ((!id && !number) || !name || !unitRaw) continue;
    const key = id !== null ? `i${id}` : `n${number}`;
    if (seen.has(key)) continue;
    const amount = num(raw.amount ?? raw.value);
    // A nutrient listed without an amount is missing: no row, never zero.
    if (amount === null) continue;
    seen.add(key);
    const derivation = isObject(raw.foodNutrientDerivation)
      ? raw.foodNutrientDerivation
      : isObject(raw.derivation)
        ? raw.derivation
        : null;
    const derivationCode = str(derivation?.code ?? raw.derivationCode, 20);
    const derivationDescription = str(derivation?.description ?? raw.derivationDescription, 200);
    out.push({
      usdaNutrientId: id,
      number,
      name,
      unit: normalUnit(unitRaw),
      amount,
      status:
        derivationDescription && BELOW.test(derivationDescription) ? "BELOW_DETECTION" : "REPORTED",
      derivationCode,
      derivationDescription,
      dataPoints: int(raw.dataPoints),
    });
  }
  return out;
}

function portionsOf(raw: Record<string, unknown>, dataType: string | null): SourcePortion[] {
  const out: SourcePortion[] = [];
  if (Array.isArray(raw.foodPortions)) {
    raw.foodPortions.forEach((p, i) => {
      if (!isObject(p)) return;
      const unit = isObject(p.measureUnit) ? str(p.measureUnit.name, 60) : null;
      const measure = unit && unit !== "undetermined" ? unit : null;
      const amount = num(p.amount);
      const portionDescription = str(p.portionDescription, 300);
      const description =
        portionDescription && portionDescription !== "Quantity not specified"
          ? portionDescription
          : [amount, measure, str(p.modifier, 120)].filter(Boolean).join(" ");
      if (!description) return;
      const ml = measure && /^(ml|milliliter|millilitre)s?$/i.test(measure) ? amount : null;
      out.push({
        sequence: int(p.sequenceNumber) ?? i + 1,
        amount,
        measure,
        description: description.slice(0, 300),
        gramWeight: num(p.gramWeight),
        millilitres: ml,
      });
    });
  }
  if (dataType === "Branded" || raw.servingSize !== undefined) {
    const size = num(raw.servingSize);
    const unit = str(raw.servingSizeUnit, 20)?.toLowerCase() ?? null;
    if (size) {
      const grams = unit === "g" || unit === "grm" ? size : null;
      const ml = unit === "ml" || unit === "mlt" ? size : null;
      const label = str(raw.householdServingFullText, 200);
      out.push({
        sequence: 0,
        amount: size,
        measure: grams ? "g" : ml ? "ml" : unit,
        description: (label
          ? `${label} (${size} ${grams ? "g" : ml ? "ml" : unit})`
          : `${size} ${unit}`
        ).slice(0, 300),
        gramWeight: grams,
        millilitres: ml,
      });
    }
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

const CORE = ["1008", "1003", "1004", "1005"];
const CORE_NUMBERS = ["208", "203", "204", "205"];

/** Findings a person should look at; the data is still imported as published. */
function checks(n: NormalizedFood): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map(n.nutrients.map((x) => [String(x.usdaNutrientId ?? ""), x]));
  const byNumber = new Map(n.nutrients.map((x) => [x.number ?? "", x]));
  const missing = CORE.filter((id, i) => !byId.has(id) && !byNumber.has(CORE_NUMBERS[i]));
  // Energy may be published under the Atwater ids instead.
  const energyOk =
    byId.has("2047") || byId.has("2048") || byNumber.has("957") || byNumber.has("958");
  const missingCore = missing.filter((id) => !(id === "1008" && energyOk));
  if (missingCore.length)
    issues.push({
      kind: "MISSING_CORE_NUTRIENTS",
      detail: `Missing: ${missingCore.map((id) => ({ "1008": "energy", "1003": "protein", "1004": "fat", "1005": "carbohydrate" })[id]).join(", ")}`,
      data: { missing: missingCore },
    });
  for (const x of n.nutrients)
    if (!KNOWN_UNITS.has(x.unit))
      issues.push({
        kind: "UNEXPECTED_UNIT",
        detail: `${x.name} in ${x.unit}`,
        data: { nutrient: x.usdaNutrientId ?? x.number, unit: x.unit },
      });
  // Plausibility per 100 g/ml: no macronutrient above 100 g, energy within 0–900 kcal.
  for (const x of n.nutrients) {
    if (x.unit === "g" && x.amount && new Decimal(x.amount).gt(100))
      issues.push({
        kind: "IMPLAUSIBLE_VALUE",
        detail: `${x.name} ${x.amount} g per 100`,
        data: { nutrient: x.usdaNutrientId ?? x.number, amount: x.amount },
      });
    if (x.unit === "kcal" && x.amount && new Decimal(x.amount).gt(900))
      issues.push({
        kind: "IMPLAUSIBLE_VALUE",
        detail: `${x.name} ${x.amount} kcal per 100`,
        data: { nutrient: x.usdaNutrientId ?? x.number, amount: x.amount },
      });
  }
  const parts = ["1003", "1004", "1005", "1051", "1007"]
    .map((id) => byId.get(id))
    .filter((x): x is SourceNutrient => !!x?.amount && x.unit === "g");
  if (parts.length === 5) {
    const total = parts.reduce((a, x) => a.plus(x.amount!), new Decimal(0));
    if (total.gt(105))
      issues.push({
        kind: "IMPLAUSIBLE_VALUE",
        detail: `Protein, fat, carbohydrate, water and ash add up to ${total.toFixed(1)} g per 100 g`,
        data: { total: total.toFixed() },
      });
  }
  return issues;
}

/** Normalize one USDA FDC food. Returns null when it has no FDC id or description. */
export function normalizeFdcFood(raw: unknown): NormalizedFood | null {
  if (!isObject(raw)) return null;
  const parsed = parseUsdaFdc(raw);
  const summary = parsed.foods[0];
  if (!summary) return null;
  const dataType = str(raw.dataType, 60);
  const category = isObject(raw.foodCategory)
    ? str(raw.foodCategory.description, 200)
    : (str(raw.foodCategory, 200) ??
      str(raw.brandedFoodCategory, 200) ??
      (isObject(raw.wweiaFoodCategory)
        ? str(raw.wweiaFoodCategory.wweiaFoodCategoryDescription, 200)
        : null));
  const barcode = str(raw.gtinUpc, 32);
  const identifiers: NormalizedFood["identifiers"] = [{ kind: "FDC_ID", value: summary.sourceId }];
  if (barcode) identifiers.push({ kind: "GTIN_UPC", value: barcode });
  const ndb = str(raw.ndbNumber, 32);
  if (ndb) identifiers.push({ kind: "NDB_NUMBER", value: ndb });
  const foodCode = str(raw.foodCode, 32);
  if (foodCode) identifiers.push({ kind: "FOOD_CODE", value: foodCode });
  const food: NormalizedFood = {
    source: "USDA_FDC",
    sourceId: summary.sourceId,
    dataType,
    name: summary.name,
    brand: summary.brand,
    barcode,
    category,
    ingredientsText: str(raw.ingredients, 5000),
    publicationDate: fdcDate(raw.publicationDate ?? raw.publishedDate),
    basis: summary.basis ?? "PER_100G",
    identifiers,
    nutrients: nutrientsOf(raw.foodNutrients ?? raw.nutrients),
    portions: portionsOf(raw, dataType),
    summary,
    issues: [],
    sourceUrl: summary.sourceUrl,
    payloadHash: payloadHash(raw),
  };
  food.issues = checks(food);
  return food;
}

// ─── Standardizing against the dictionary ───

export interface DictionaryEntry {
  id: string;
  code: string | null;
  usdaNutrientId: number | null;
  usdaNumber: string | null;
  unit: string;
}

const MASS: Record<string, Decimal> = {
  g: new Decimal(1),
  mg: new Decimal("0.001"),
  µg: new Decimal("0.000001"),
};

/** An amount from one unit into another: mass units convert; anything else only to itself. */
export function convertAmount(amount: string, from: string, to: string): Decimal | null {
  if (from === to) return new Decimal(amount);
  if (MASS[from] && MASS[to]) return new Decimal(amount).times(MASS[from]).dividedBy(MASS[to]);
  return null;
}

export interface StandardValue {
  nutrientId: string;
  code: string | null;
  status: ValueStatus;
  sourceNutrientId: number | null;
  sourceNumber: string | null;
  originalAmount: string | null;
  originalUnit: string | null;
  amount: string | null;
  unit: string;
  derivationCode: string | null;
  derivationDescription: string | null;
  dataPoints: number | null;
  note: string | null;
}

/**
 * Each source nutrient against the dictionary entry with its USDA id (else
 * number), in the dictionary's unit. A below-detection value keeps its
 * original figure but no standard amount; a unit that cannot be converted
 * keeps the original and is reported. Unknown nutrients are returned for the
 * dictionary to learn. Salt from sodium and kJ from kcal are added as
 * CALCULATED when the source gives none.
 */
export function standardize(
  food: NormalizedFood,
  dictionary: readonly DictionaryEntry[],
): { values: StandardValue[]; unknown: SourceNutrient[]; issues: Issue[] } {
  const byId = new Map(
    dictionary.filter((d) => d.usdaNutrientId !== null).map((d) => [d.usdaNutrientId, d]),
  );
  const byNumber = new Map(dictionary.filter((d) => d.usdaNumber).map((d) => [d.usdaNumber, d]));
  const byCode = new Map(dictionary.filter((d) => d.code).map((d) => [d.code, d]));
  const values: StandardValue[] = [];
  const unknown: SourceNutrient[] = [];
  const issues: Issue[] = [];
  const taken = new Set<string>();
  for (const n of food.nutrients) {
    const d =
      (n.usdaNutrientId !== null ? byId.get(n.usdaNutrientId) : undefined) ??
      (n.number ? byNumber.get(n.number) : undefined);
    if (!d) {
      unknown.push(n);
      continue;
    }
    if (taken.has(d.id)) continue;
    taken.add(d.id);
    let amount: Decimal | null = null;
    let note: string | null = null;
    if (n.status !== "BELOW_DETECTION" && n.amount !== null) {
      amount = convertAmount(n.amount, n.unit, d.unit);
      if (amount === null) {
        note = `published in ${n.unit}; not converted to ${d.unit}`;
        issues.push({
          kind: "UNIT_MISMATCH",
          detail: `${n.name}: ${n.unit}, dictionary ${d.unit}`,
          data: { nutrient: n.usdaNutrientId ?? n.number },
        });
      }
    }
    values.push({
      nutrientId: d.id,
      code: d.code,
      status: n.status,
      sourceNutrientId: n.usdaNutrientId,
      sourceNumber: n.number,
      originalAmount: n.amount,
      originalUnit: n.unit,
      amount: amount ? amount.toDecimalPlaces(6).toFixed() : null,
      unit: d.unit,
      derivationCode: n.derivationCode,
      derivationDescription: n.derivationDescription,
      dataPoints: n.dataPoints,
      note,
    });
  }
  const has = (code: string) => values.find((v) => v.code === code && v.amount !== null);
  const sodium = has("sodium");
  const salt = byCode.get("salt");
  if (sodium && salt && !values.some((v) => v.code === "salt")) {
    values.push(
      calculated(salt, salt2(sodium.amount!, sodium.unit), "salt = sodium (mg) × 2.5 ÷ 1000"),
    );
  }
  const kcal = has("energy_kcal");
  const kj = byCode.get("energy_kj");
  if (kcal && kj && !values.some((v) => v.code === "energy_kj")) {
    values.push(calculated(kj, new Decimal(kcal.amount!).times("4.184"), "kJ = kcal × 4.184"));
  }
  return { values, unknown, issues };
}

const salt2 = (sodiumAmount: string, unit: string) =>
  (convertAmount(sodiumAmount, unit, "mg") as Decimal).times("2.5").dividedBy(1000);

function calculated(d: DictionaryEntry, amount: Decimal, note: string): StandardValue {
  return {
    nutrientId: d.id,
    code: d.code,
    status: "CALCULATED",
    sourceNutrientId: null,
    sourceNumber: null,
    originalAmount: null,
    originalUnit: null,
    amount: amount.toDecimalPlaces(6).toFixed(),
    unit: d.unit,
    derivationCode: null,
    derivationDescription: null,
    dataPoints: null,
    note,
  };
}
