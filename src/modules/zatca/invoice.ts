import { createHash } from "node:crypto";
import { Decimal } from "@/lib/decimal";
import { el, leaf } from "./xml";

/**
 * UBL 2.1 XML for ZATCA tax invoices and notes — simplified (B2C, the point
 * of sale, ADR-064) and standard (B2B, cleared, ADR-072) — and the invoice
 * hash.
 *
 * NOT YET VALIDATED against ZATCA: the sandbox host was not reachable from
 * the development environment. Element order, amounts and the hash follow
 * the published standards; run the compliance checks before any live use.
 */

export const NS = {
  inv: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  ext: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
};

/** First "previous invoice hash" of a device: base64 of the SHA-256 of "0" as hex. */
export const FIRST_PIH = Buffer.from(createHash("sha256").update("0").digest("hex")).toString(
  "base64",
);

export type TaxCategory = "S" | "Z" | "E" | "O";

export interface ZatcaParty {
  name: string;
  vatNumber: string;
  crNumber?: string | null;
  street: string;
  building: string;
  district: string;
  city: string;
  postalCode: string;
}

/** The buyer on a standard invoice (BR-KSA-10, -14, -63). */
export interface ZatcaBuyer {
  name: string;
  /** 15-digit VAT number, when the buyer is VAT registered. */
  vatNumber?: string | null;
  /** Another identifier when there is no VAT number (e.g. CRN commercial registration). */
  otherId?: { scheme: "CRN" | "MOM" | "MLS" | "SAG" | "OTH"; id: string } | null;
  street: string;
  building?: string | null;
  district?: string | null;
  city: string;
  postalCode?: string | null;
  /** ISO 3166 alpha-2. */
  country: string;
}

export interface ZatcaLine {
  name: string;
  quantity: Decimal;
  /** Amount without VAT for the line (2 decimals). */
  net: Decimal;
  vat: Decimal;
  category: TaxCategory;
  /** Percent, e.g. 15. */
  percent: Decimal;
  exemptionCode?: string;
  exemptionReason?: string;
}

export interface ZatcaInvoiceInput {
  type: "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE";
  /** SIMPLIFIED (B2C, reported; default) or STANDARD (B2B, cleared before it is given). */
  kind?: "SIMPLIFIED" | "STANDARD";
  /** Standard documents: the buyer, and the date of supply (KSA-5). */
  buyer?: ZatcaBuyer;
  deliveryDate?: string;
  /** The VAT in SAR when the document is in another currency (BR-KSA-68). */
  vatInSar?: Decimal;
  number: string;
  uuid: string;
  /** Seller's local date and time of issue. */
  issueDate: string;
  issueTime: string;
  /** Invoice counter value of the device (KSA-16). */
  icv: number;
  /** Hash of the device's previous document (KSA-13). */
  pih: string;
  currency: string;
  seller: ZatcaParty;
  /** 10 cash, 48 card. */
  /** UNTDID 4461 subset accepted by ZATCA (BR-KSA-16): 10 cash, 48 bank card, 1 not defined. */
  paymentMeans: "1" | "10" | "48";
  lines: ZatcaLine[];
  /** For a credit note: the invoice it corrects, and why (KSA-10). */
  billingReference?: string;
  reason?: string;
}

/** 388 invoice, 381 credit note, 383 debit note; name 0100000 standard, 0200000 simplified. */
const TYPE_CODE = { INVOICE: "388", CREDIT_NOTE: "381", DEBIT_NOTE: "383" } as const;

const money = (d: Decimal) => d.toFixed(2);
const qty = (d: Decimal) => {
  const s = d.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
};

function taxCategory(tag: "cac:TaxCategory" | "cac:ClassifiedTaxCategory", l: ZatcaLine) {
  return el(
    tag,
    {},
    leaf("cbc:ID", l.category),
    leaf("cbc:Percent", l.percent.toFixed(2)),
    l.exemptionCode ? leaf("cbc:TaxExemptionReasonCode", l.exemptionCode) : null,
    l.exemptionReason ? leaf("cbc:TaxExemptionReason", l.exemptionReason) : null,
    el("cac:TaxScheme", {}, leaf("cbc:ID", "VAT")),
  );
}

export function totals(lines: readonly ZatcaLine[]) {
  const sum = (f: (l: ZatcaLine) => Decimal) =>
    lines.reduce((a, l) => a.plus(f(l)), new Decimal(0));
  const net = sum((l) => l.net);
  const vat = sum((l) => l.vat);
  return { net, vat, gross: net.plus(vat) };
}

/**
 * The invoice XML. Without `stamp` it is the "pure" invoice that is hashed
 * (no UBL extensions, no signature reference, no QR); with it, the signed
 * document sent to ZATCA.
 */
export function invoiceXml(
  input: ZatcaInvoiceInput,
  stamp?: { ublExtensions: string; qr: string },
): string {
  const cur = { currencyID: input.currency };
  const t = totals(input.lines);
  const groups = new Map<string, ZatcaLine[]>();
  for (const l of input.lines) {
    const key = `${l.category}|${l.percent.toFixed(2)}|${l.exemptionCode ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const s = input.seller;
  const b = input.kind === "STANDARD" ? input.buyer : undefined;
  if (input.kind === "STANDARD" && !b) throw new Error("A standard invoice needs its buyer");
  const sar = { currencyID: "SAR" };
  return el(
    "Invoice",
    { xmlns: NS.inv, "xmlns:cac": NS.cac, "xmlns:cbc": NS.cbc, "xmlns:ext": NS.ext },
    stamp?.ublExtensions,
    leaf("cbc:ProfileID", "reporting:1.0"),
    leaf("cbc:ID", input.number),
    leaf("cbc:UUID", input.uuid),
    leaf("cbc:IssueDate", input.issueDate),
    leaf("cbc:IssueTime", input.issueTime),
    leaf("cbc:InvoiceTypeCode", TYPE_CODE[input.type], {
      name: input.kind === "STANDARD" ? "0100000" : "0200000",
    }),
    leaf("cbc:DocumentCurrencyCode", input.currency),
    // VAT is always accounted in SAR (BR-KSA-68).
    leaf("cbc:TaxCurrencyCode", "SAR"),
    input.billingReference
      ? el(
          "cac:BillingReference",
          {},
          el("cac:InvoiceDocumentReference", {}, leaf("cbc:ID", input.billingReference)),
        )
      : null,
    el(
      "cac:AdditionalDocumentReference",
      {},
      leaf("cbc:ID", "ICV"),
      leaf("cbc:UUID", String(input.icv)),
    ),
    el(
      "cac:AdditionalDocumentReference",
      {},
      leaf("cbc:ID", "PIH"),
      el(
        "cac:Attachment",
        {},
        leaf("cbc:EmbeddedDocumentBinaryObject", input.pih, { mimeCode: "text/plain" }),
      ),
    ),
    stamp
      ? el(
          "cac:AdditionalDocumentReference",
          {},
          leaf("cbc:ID", "QR"),
          el(
            "cac:Attachment",
            {},
            leaf("cbc:EmbeddedDocumentBinaryObject", stamp.qr, { mimeCode: "text/plain" }),
          ),
        )
      : null,
    stamp
      ? el(
          "cac:Signature",
          {},
          leaf("cbc:ID", "urn:oasis:names:specification:ubl:signature:Invoice"),
          leaf("cbc:SignatureMethod", "urn:oasis:names:specification:ubl:dsig:enveloped:xades"),
        )
      : null,
    el(
      "cac:AccountingSupplierParty",
      {},
      el(
        "cac:Party",
        {},
        s.crNumber
          ? el("cac:PartyIdentification", {}, leaf("cbc:ID", s.crNumber, { schemeID: "CRN" }))
          : null,
        el(
          "cac:PostalAddress",
          {},
          leaf("cbc:StreetName", s.street),
          leaf("cbc:BuildingNumber", s.building),
          leaf("cbc:CitySubdivisionName", s.district),
          leaf("cbc:CityName", s.city),
          leaf("cbc:PostalZone", s.postalCode),
          el("cac:Country", {}, leaf("cbc:IdentificationCode", "SA")),
        ),
        el(
          "cac:PartyTaxScheme",
          {},
          leaf("cbc:CompanyID", s.vatNumber),
          el("cac:TaxScheme", {}, leaf("cbc:ID", "VAT")),
        ),
        el("cac:PartyLegalEntity", {}, leaf("cbc:RegistrationName", s.name)),
      ),
    ),
    b ? buyerParty(b) : null,
    input.deliveryDate
      ? el("cac:Delivery", {}, leaf("cbc:ActualDeliveryDate", input.deliveryDate))
      : null,
    el(
      "cac:PaymentMeans",
      {},
      leaf("cbc:PaymentMeansCode", input.paymentMeans),
      input.reason ? leaf("cbc:InstructionNote", input.reason) : null,
    ),
    // The VAT total in the tax currency (SAR); the next one, with subtotals, in the document's.
    el("cac:TaxTotal", {}, leaf("cbc:TaxAmount", money(input.vatInSar ?? t.vat), sar)),
    el(
      "cac:TaxTotal",
      {},
      leaf("cbc:TaxAmount", money(t.vat), cur),
      ...[...groups.values()].map((g) => {
        const gt = totals(g);
        return el(
          "cac:TaxSubtotal",
          {},
          leaf("cbc:TaxableAmount", money(gt.net), cur),
          leaf("cbc:TaxAmount", money(gt.vat), cur),
          taxCategory("cac:TaxCategory", g[0]),
        );
      }),
    ),
    el(
      "cac:LegalMonetaryTotal",
      {},
      leaf("cbc:LineExtensionAmount", money(t.net), cur),
      leaf("cbc:TaxExclusiveAmount", money(t.net), cur),
      leaf("cbc:TaxInclusiveAmount", money(t.gross), cur),
      leaf("cbc:AllowanceTotalAmount", "0.00", cur),
      leaf("cbc:PrepaidAmount", "0.00", cur),
      leaf("cbc:PayableAmount", money(t.gross), cur),
    ),
    ...input.lines.map((l, i) =>
      el(
        "cac:InvoiceLine",
        {},
        leaf("cbc:ID", String(i + 1)),
        leaf("cbc:InvoicedQuantity", qty(l.quantity), { unitCode: "PCE" }),
        leaf("cbc:LineExtensionAmount", money(l.net), cur),
        el(
          "cac:TaxTotal",
          {},
          leaf("cbc:TaxAmount", money(l.vat), cur),
          leaf("cbc:RoundingAmount", money(l.net.plus(l.vat)), cur),
        ),
        el("cac:Item", {}, leaf("cbc:Name", l.name), taxCategory("cac:ClassifiedTaxCategory", l)),
        el(
          "cac:Price",
          {},
          leaf("cbc:PriceAmount", qty(l.net.div(l.quantity).toDecimalPlaces(6)), cur),
        ),
      ),
    ),
  );
}

function buyerParty(b: ZatcaBuyer) {
  return el(
    "cac:AccountingCustomerParty",
    {},
    el(
      "cac:Party",
      {},
      !b.vatNumber && b.otherId
        ? el(
            "cac:PartyIdentification",
            {},
            leaf("cbc:ID", b.otherId.id, { schemeID: b.otherId.scheme }),
          )
        : null,
      el(
        "cac:PostalAddress",
        {},
        leaf("cbc:StreetName", b.street),
        b.building ? leaf("cbc:BuildingNumber", b.building) : null,
        b.district ? leaf("cbc:CitySubdivisionName", b.district) : null,
        leaf("cbc:CityName", b.city),
        b.postalCode ? leaf("cbc:PostalZone", b.postalCode) : null,
        el("cac:Country", {}, leaf("cbc:IdentificationCode", b.country)),
      ),
      b.vatNumber
        ? el(
            "cac:PartyTaxScheme",
            {},
            leaf("cbc:CompanyID", b.vatNumber),
            el("cac:TaxScheme", {}, leaf("cbc:ID", "VAT")),
          )
        : null,
      el("cac:PartyLegalEntity", {}, leaf("cbc:RegistrationName", b.name)),
    ),
  );
}

/**
 * What a standard invoice's buyer is missing for ZATCA (BR-KSA-63 and
 * related rules): a Saudi buyer needs street, 4-digit building number,
 * district, city and 5-digit postal code; every buyer a name and either a
 * valid VAT number or another identifier.
 */
export function buyerProblems(b: Partial<ZatcaBuyer>): string[] {
  const out: string[] = [];
  if (!b.name?.trim()) out.push("name");
  if (b.vatNumber && !/^3\d{13}3$/.test(b.vatNumber)) out.push("vatNumber");
  if (!b.vatNumber && !b.otherId?.id) out.push("vatNumber");
  if (!b.street?.trim()) out.push("street");
  if (!b.city?.trim()) out.push("city");
  if (!b.country || !/^[A-Z]{2}$/.test(b.country)) out.push("country");
  if (b.country === "SA") {
    if (!b.building || !/^\d{4}$/.test(b.building)) out.push("building");
    if (!b.district?.trim()) out.push("district");
    if (!b.postalCode || !/^\d{5}$/.test(b.postalCode)) out.push("postalCode");
  }
  return out;
}

/** Invoice hash (KSA-13 / digest): SHA-256 of the canonical pure invoice, base64. */
export function invoiceHash(pureXml: string): string {
  return createHash("sha256").update(pureXml, "utf8").digest("base64");
}

/** The signed document as sent: the XML declaration and the stamped invoice. */
export function signedDocument(xml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
}
