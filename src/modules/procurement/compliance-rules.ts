/**
 * Supplier compliance rules (DECISIONS.md ADR-091). Pure; no I/O.
 */

export type SupplierStatus = "PENDING_APPROVAL" | "APPROVED" | "BLOCKED";

/**
 * Why an order to this supplier cannot go ahead, or null.
 * - "draft": preparing an order. Only a blocked supplier is refused, so a
 *   buyer can prepare an order while the supplier waits for approval.
 * - "send": submitting or approving. The supplier must be approved and hold
 *   no expired document marked "required to buy".
 */
export function supplierOrderBlock(input: {
  status: SupplierStatus;
  expiredRequiredDocuments: number;
  step: "draft" | "send";
}): "SUPPLIER_BLOCKED" | "SUPPLIER_NOT_APPROVED" | "SUPPLIER_DOCUMENT_EXPIRED" | null {
  if (input.status === "BLOCKED") return "SUPPLIER_BLOCKED";
  if (input.step === "draft") return null;
  if (input.status !== "APPROVED") return "SUPPLIER_NOT_APPROVED";
  if (input.expiredRequiredDocuments > 0) return "SUPPLIER_DOCUMENT_EXPIRED";
  return null;
}

/** Spaces and dashes removed, upper case. */
export function normalizeAccount(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

/**
 * IBAN lengths for the countries we sell in and their usual trading partners
 * (SWIFT IBAN registry). Other countries are checked by the checksum alone.
 */
const IBAN_LENGTHS: Record<string, number> = {
  SA: 24,
  AE: 23,
  EG: 29,
  KW: 30,
  QA: 29,
  BH: 22,
  OM: 23,
  JO: 30,
  LB: 28,
  TR: 26,
  GB: 22,
  DE: 22,
  FR: 27,
  IT: 27,
  ES: 24,
  NL: 18,
  BE: 16,
  CH: 21,
  PK: 24,
};

/** Shape, known country length, and the ISO 13616 mod-97 check. */
export function ibanProblem(raw: string): "format" | "length" | "checksum" | null {
  const iban = normalizeAccount(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return "format";
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) return "length";
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1 ? null : "checksum";
}

/** A local account number: 4–34 letters and digits. */
export function accountNumberValid(raw: string): boolean {
  return /^[A-Z0-9]{4,34}$/.test(normalizeAccount(raw));
}

/** SWIFT/BIC: bank (4 letters), country (2), location (2), optional branch (3). */
export function swiftValid(raw: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(normalizeAccount(raw));
}

export function lastFour(account: string): string {
  return normalizeAccount(account).slice(-4);
}

/** How an account is shown without revealing it: "•••• 1234". */
export function maskedAccount(last4: string): string {
  return `•••• ${last4}`;
}

/** An IBAN in groups of four, as printed on bank documents. */
export function groupedAccount(account: string): string {
  return normalizeAccount(account).replace(/(.{4})(?=.)/g, "$1 ");
}
