export const SYMBOLOGIES = ["EAN13", "EAN8", "UPC_A", "CODE128", "QR", "INTERNAL"] as const;
export type Symbology = (typeof SYMBOLOGIES)[number];

/** GS1 mod-10 check digit validation (EAN-13, EAN-8, UPC-A). */
export function hasValidGs1CheckDigit(code: string): boolean {
  if (!/^\d+$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // Weights alternate 3,1,3,… starting from the digit next to the check digit.
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

const LENGTH: Partial<Record<Symbology, number>> = { EAN13: 13, EAN8: 8, UPC_A: 12 };

/** Returns an error key, or null if the barcode is valid for its symbology. */
export function validateBarcode(
  code: string,
  symbology: Symbology,
): "invalidBarcode" | "invalidCheckDigit" | null {
  const expected = LENGTH[symbology];
  if (expected !== undefined) {
    if (!new RegExp(`^\\d{${expected}}$`).test(code)) return "invalidBarcode";
    return hasValidGs1CheckDigit(code) ? null : "invalidCheckDigit";
  }
  return /^[\x21-\x7e]{1,64}$/.test(code) ? null : "invalidBarcode";
}
