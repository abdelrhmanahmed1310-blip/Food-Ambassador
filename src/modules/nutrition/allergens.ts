/**
 * The allergens tracked for every product (DECISIONS.md ADR-040): the 14 of
 * EU Regulation 1169/2011 Annex II. `codex` marks the categories in Codex
 * CXS 1-1985 §4.2.1.4, the basis of most Gulf and Egyptian labelling rules.
 * Which list a market's label must follow is still open (Q-02); tracking all
 * 14 never hides one.
 */
export const ALLERGENS = [
  { code: "GLUTEN", codex: true },
  { code: "CRUSTACEANS", codex: true },
  { code: "EGGS", codex: true },
  { code: "FISH", codex: true },
  { code: "PEANUTS", codex: true },
  { code: "SOY", codex: true },
  { code: "MILK", codex: true },
  { code: "TREE_NUTS", codex: true },
  { code: "CELERY", codex: false },
  { code: "MUSTARD", codex: false },
  { code: "SESAME", codex: false },
  { code: "SULPHITES", codex: true },
  { code: "LUPIN", codex: false },
  { code: "MOLLUSCS", codex: false },
] as const;

export type AllergenCode = (typeof ALLERGENS)[number]["code"];
export const ALLERGEN_CODES: readonly AllergenCode[] = ALLERGENS.map((a) => a.code);

export function isAllergenCode(v: string): v is AllergenCode {
  return (ALLERGEN_CODES as readonly string[]).includes(v);
}
