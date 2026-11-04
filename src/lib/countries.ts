/**
 * ISO 3166-1 alpha-2 countries from the runtime's CLDR data (no list kept
 * here): every region code with a name whose canonical form is itself,
 * less groupings and exceptional reservations.
 */
const NOT_COUNTRIES = new Set([
  "EU",
  "EZ",
  "QO",
  "UN",
  "XA",
  "XB",
  "ZZ",
  "AC",
  "CP",
  "CQ",
  "DG",
  "EA",
  "IC",
  "TA",
]);

let codes: string[] | null = null;

export function countryCodes(): string[] {
  if (codes) return codes;
  const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const out: string[] = [];
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const c = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(c) || !names.of(c)) continue;
      if (Intl.getCanonicalLocales(`und-${c}`)[0] !== `und-${c}`) continue;
      out.push(c);
    }
  codes = out;
  return out;
}

export const isCountryCode = (c: string) => countryCodes().includes(c);

export function countryOptions(locale: string): Array<{ value: string; label: string }> {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  return countryCodes()
    .map((c) => ({ value: c, label: `${names.of(c) ?? c} (${c})` }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}
