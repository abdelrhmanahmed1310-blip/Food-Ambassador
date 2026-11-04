/**
 * Barcodes for warehouse labels and scanning (DECISIONS.md ADR-104). Pure.
 * Code 128 (code set B) is read by keyboard-style handheld scanners and by
 * the browser's camera barcode reader; labels carry our own numbers (pack
 * units, locations, lots), not GS1 identifiers.
 */

/** Bar/space module widths for Code 128 values 0–105; 106 is the stop pattern. */
// prettier-ignore
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
] as const;

export const CODE128_PATTERNS: readonly string[] = PATTERNS;
const START_B = 104;
const STOP = 106;

/** Code set B covers printable ASCII (space to tilde). */
export function encodable(text: string): boolean {
  return text.length > 0 && text.length <= 80 && /^[\x20-\x7e]+$/.test(text);
}

/** Symbol values: start B, the characters, the checksum, stop. */
export function code128Values(text: string): number[] {
  if (!encodable(text)) throw new Error("Code 128 B takes 1–80 printable ASCII characters");
  const data = [...text].map((c) => c.charCodeAt(0) - 32);
  const checksum = data.reduce((sum, v, i) => sum + v * (i + 1), START_B) % 103;
  return [START_B, ...data, checksum, STOP];
}

/**
 * Bars as [x, width] in modules, with a 10-module quiet zone on each side;
 * `width` is the total width in modules.
 */
export function code128Bars(text: string): { bars: Array<[number, number]>; width: number } {
  const bars: Array<[number, number]> = [];
  let x = 10;
  for (const v of code128Values(text)) {
    const widths = [...PATTERNS[v]].map(Number);
    widths.forEach((w, i) => {
      if (i % 2 === 0) bars.push([x, w]);
      x += w;
    });
  }
  return { bars, width: x + 10 };
}

/**
 * What a scanner sent, cleaned: keyboard-style scanners end with Enter or
 * Tab and may add GS1 group separators; cameras may add whitespace.
 */
export function normalizeScan(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 120);
}

/** Count lines matching a scanned product barcode, SKU or lot code (ADR-104). */
export function matchesScan(
  line: {
    product: { id: string; sku: string; barcodes: string[] };
    lot: { lotCode: string } | null;
  },
  code: string,
): boolean {
  const c = normalizeScan(code);
  return (
    line.product.sku === c.toUpperCase() ||
    line.product.barcodes.includes(c) ||
    (line.lot !== null && line.lot.lotCode === c)
  );
}
