/**
 * The ZATCA QR code: tag-length-value fields, base64 encoded (ADR-064).
 * Phase 1 has tags 1–5 (seller, VAT number, time, total, VAT); Phase 2 adds
 * 6 invoice hash, 7 signature, 8 public key, 9 the certificate's signature.
 */
export function encodeTlv(values: ReadonlyArray<string | Buffer>): string {
  const parts = values.map((v, i) => {
    const b = typeof v === "string" ? Buffer.from(v, "utf8") : v;
    if (b.length > 255) throw new RangeError(`QR field ${i + 1} is too long`);
    return Buffer.concat([Buffer.from([i + 1, b.length]), b]);
  });
  return Buffer.concat(parts).toString("base64");
}

export function decodeTlv(base64: string): Map<number, Buffer> {
  const b = Buffer.from(base64, "base64");
  const out = new Map<number, Buffer>();
  for (let at = 0; at < b.length;) {
    const tag = b[at];
    const length = b[at + 1];
    out.set(tag, b.subarray(at + 2, at + 2 + length));
    at += 2 + length;
  }
  return out;
}

export interface QrFields {
  sellerName: string;
  vatNumber: string;
  /** Issue date and time as on the invoice: YYYY-MM-DDTHH:mm:ss. */
  timestamp: string;
  total: string;
  vat: string;
}

/** Phase 1 QR (required on every simplified tax invoice since December 2021). */
export function phase1Qr(f: QrFields): string {
  return encodeTlv([f.sellerName, f.vatNumber, f.timestamp, f.total, f.vat]);
}

/** Phase 2 QR: Phase 1 fields plus the cryptographic stamp. */
export function phase2Qr(
  f: QrFields & {
    invoiceHash: string;
    signature: string;
    publicKey: Buffer;
    certSignature: Buffer;
  },
): string {
  return encodeTlv([
    f.sellerName,
    f.vatNumber,
    f.timestamp,
    f.total,
    f.vat,
    f.invoiceHash,
    f.signature,
    f.publicKey,
    f.certSignature,
  ]);
}
