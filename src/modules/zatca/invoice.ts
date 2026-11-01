import { createHash } from "node:crypto";
import { Decimal } from "@/lib/decimal";
import { el, leaf } from "./xml";

/**
 * UBL 2.1 XML for ZATCA simplified tax invoices and credit notes (B2C, the
 * point of sale), and the invoice hash (DECISIONS.md ADR-064).
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

/** 388 invoice, 381 credit note, 383 debit note (simplified: name 0200000). */
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
  return el(
    "Invoice",
    { xmlns: NS.inv, "xmlns:cac": NS.cac, "xmlns:cbc": NS.cbc, "xmlns:ext": NS.ext },
    stamp?.ublExtensions,
    leaf("cbc:ProfileID", "reporting:1.0"),
    leaf("cbc:ID", input.number),
    leaf("cbc:UUID", input.uuid),
    leaf("cbc:IssueDate", input.issueDate),
    leaf("cbc:IssueTime", input.issueTime),
    leaf("cbc:InvoiceTypeCode", TYPE_CODE[input.type], { name: "0200000" }),
    leaf("cbc:DocumentCurrencyCode", input.currency),
    leaf("cbc:TaxCurrencyCode", input.currency),
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
    el(
      "cac:PaymentMeans",
      {},
      leaf("cbc:PaymentMeansCode", input.paymentMeans),
      input.reason ? leaf("cbc:InstructionNote", input.reason) : null,
    ),
    el("cac:TaxTotal", {}, leaf("cbc:TaxAmount", money(t.vat), cur)),
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

/** Invoice hash (KSA-13 / digest): SHA-256 of the canonical pure invoice, base64. */
export function invoiceHash(pureXml: string): string {
  return createHash("sha256").update(pureXml, "utf8").digest("base64");
}

/** The signed document as sent: the XML declaration and the stamped invoice. */
export function signedDocument(xml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
}
