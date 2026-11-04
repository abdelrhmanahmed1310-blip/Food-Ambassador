/**
 * Trade documents and requirements (DECISIONS.md ADR-114). Pure.
 */

/** Flagged this many days before expiry, as supplier and HR documents (ADR-079, ADR-091). */
export const EXPIRY_WARNING_DAYS = 30;

export type ExpiryState = "NO_EXPIRY" | "VALID" | "EXPIRING" | "EXPIRED";

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** A document expiring today is still valid today. */
export function expiryState(expiresOn: string | null, today: string): ExpiryState {
  if (!expiresOn) return "NO_EXPIRY";
  if (expiresOn < today) return "EXPIRED";
  return (ms(expiresOn) - ms(today)) / DAY <= EXPIRY_WARNING_DAYS ? "EXPIRING" : "VALID";
}

export interface Requirement {
  id: string;
  documentTypeId: string;
  scope: "SHIPMENT" | "PRODUCT";
  destinationCountry: string | null;
  originCountry: string | null;
  hsPrefix: string | null;
}

export interface ShipmentFacts {
  /** The importing company's country (null when not set). */
  destination: string | null;
  origin: string | null;
  products: Array<{ id: string; hsCode: string | null; originCountry: string | null }>;
}

/**
 * Which requirements apply to a shipment, and for which of its products.
 * A product's origin is its own, else the shipment's. Unknown facts never
 * match a condition (an HS prefix needs an HS code; a country condition
 * needs a known country) — the checklist reports the unknowns instead.
 */
export function applicable(reqs: ReadonlyArray<Requirement>, s: ShipmentFacts) {
  const out: Array<{ requirement: Requirement; productIds: string[] }> = [];
  for (const r of reqs) {
    if (r.destinationCountry && r.destinationCountry !== s.destination) continue;
    const products = s.products.filter(
      (p) =>
        (!r.hsPrefix || (p.hsCode !== null && p.hsCode.startsWith(r.hsPrefix))) &&
        (!r.originCountry || (p.originCountry ?? s.origin) === r.originCountry),
    );
    // A shipment-wide document with no product condition applies to the shipment itself.
    const shipmentWide =
      r.scope === "SHIPMENT" && !r.hsPrefix && (!r.originCountry || s.origin === r.originCountry);
    if (products.length === 0 && !shipmentWide) continue;
    out.push({ requirement: r, productIds: products.map((p) => p.id) });
  }
  return out;
}

export interface HeldDocument {
  id: string;
  documentTypeId: string;
  shipmentId: string | null;
  productId: string | null;
  expiresOn: string | null;
}

export type CheckState = "MISSING" | "EXPIRED" | "EXPIRING" | "OK";

/**
 * One line per shipment-scope requirement, one per product for product-scope
 * ones: the best document held (latest expiry) and its state today.
 */
export function checklist(
  applied: ReturnType<typeof applicable>,
  docs: ReadonlyArray<HeldDocument>,
  shipmentId: string,
  today: string,
) {
  const best = (list: HeldDocument[]) =>
    list.sort((a, b) =>
      (b.expiresOn ?? "9999-12-31").localeCompare(a.expiresOn ?? "9999-12-31"),
    )[0] ?? null;
  const state = (d: HeldDocument | null): CheckState => {
    if (!d) return "MISSING";
    const e = expiryState(d.expiresOn, today);
    return e === "EXPIRED" ? "EXPIRED" : e === "EXPIRING" ? "EXPIRING" : "OK";
  };
  const lines: Array<{
    requirementId: string;
    documentTypeId: string;
    productId: string | null;
    documentId: string | null;
    state: CheckState;
  }> = [];
  const seen = new Set<string>();
  for (const { requirement: r, productIds } of applied) {
    const targets = r.scope === "SHIPMENT" ? [null] : productIds;
    for (const productId of targets) {
      // Two requirements for the same document and target are one line.
      const key = `${r.documentTypeId}|${productId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const doc = best(
        docs.filter(
          (d) =>
            d.documentTypeId === r.documentTypeId &&
            (productId === null ? d.shipmentId === shipmentId : d.productId === productId),
        ),
      );
      lines.push({
        requirementId: r.id,
        documentTypeId: r.documentTypeId,
        productId,
        documentId: doc?.id ?? null,
        state: state(doc),
      });
    }
  }
  return lines;
}

/** Blocks customs clearance: anything missing or expired. */
export const blocksClearance = (lines: ReadonlyArray<{ state: CheckState }>) =>
  lines.some((l) => l.state === "MISSING" || l.state === "EXPIRED");
