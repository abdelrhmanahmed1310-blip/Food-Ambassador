import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { clearOutcome, qrOf } from "./client";
import {
  buyerProblems,
  FIRST_PIH,
  invoiceXml,
  type ZatcaBuyer,
  type ZatcaInvoiceInput,
} from "./invoice";

/** Standard (B2B) tax invoices (ADR-072). */

const d = (v: string) => new Decimal(v);
const buyer: ZatcaBuyer = {
  name: "Hotel Supplies Co",
  vatNumber: "300000000000003",
  street: "Olaya Street",
  building: "4321",
  district: "Al Malaz",
  city: "Riyadh",
  postalCode: "12622",
  country: "SA",
};
const input = (over: Partial<ZatcaInvoiceInput> = {}): ZatcaInvoiceInput => ({
  type: "INVOICE",
  kind: "STANDARD",
  number: "SI-2026-000001",
  uuid: "0b9a4c7e-2f1d-4a8b-9a0e-5c2d1e3f4a5b",
  issueDate: "2026-11-02",
  issueTime: "10:00:00",
  icv: 1,
  pih: FIRST_PIH,
  currency: "SAR",
  seller: {
    name: "Central Kitchen Co",
    vatNumber: "310122393500003",
    crNumber: "1010010000",
    street: "King Fahd Road",
    building: "1234",
    district: "Al Olaya",
    city: "Riyadh",
    postalCode: "12211",
  },
  paymentMeans: "1",
  lines: [
    {
      name: "Tomato sauce 5 kg",
      quantity: d("10"),
      net: d("200"),
      vat: d("30"),
      category: "S",
      percent: d("15"),
    },
  ],
  buyer,
  deliveryDate: "2026-11-01",
  ...over,
});

describe("standard invoices (ADR-072)", () => {
  it("carries the standard type, the buyer and the supply date", () => {
    const xml = invoiceXml(input());
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');
    expect(xml).toContain("<cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>");
    const party = xml.slice(
      xml.indexOf("<cac:AccountingCustomerParty>"),
      xml.indexOf("</cac:AccountingCustomerParty>"),
    );
    expect(party).toContain("<cbc:CompanyID>300000000000003</cbc:CompanyID>");
    expect(party).toContain("<cbc:BuildingNumber>4321</cbc:BuildingNumber>");
    expect(party).toContain("<cbc:RegistrationName>Hotel Supplies Co</cbc:RegistrationName>");
    // Buyer after the seller, delivery after the buyer, then payment means (UBL order).
    const order = [
      "<cac:AccountingSupplierParty>",
      "<cac:AccountingCustomerParty>",
      "<cac:Delivery>",
      "<cac:PaymentMeans>",
    ].map((t) => xml.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(xml).toContain("<cbc:ActualDeliveryDate>2026-11-01</cbc:ActualDeliveryDate>");
    // A simplified invoice keeps its type and has no buyer.
    const simplified = invoiceXml(input({ kind: "SIMPLIFIED" }));
    expect(simplified).toContain('name="0200000"');
    expect(simplified).not.toContain("AccountingCustomerParty");
  });

  it("accounts VAT in SAR for an invoice in another currency", () => {
    const xml = invoiceXml(input({ currency: "USD", vatInSar: d("112.50") }));
    expect(xml).toContain("<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>");
    expect(xml).toContain('<cbc:TaxAmount currencyID="SAR">112.50</cbc:TaxAmount>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="USD">30.00</cbc:TaxAmount>');
  });

  it("identifies a buyer without VAT number by another id", () => {
    const xml = invoiceXml(
      input({ buyer: { ...buyer, vatNumber: null, otherId: { scheme: "CRN", id: "1010101010" } } }),
    );
    expect(xml).toContain('<cbc:ID schemeID="CRN">1010101010</cbc:ID>');
    expect(() => invoiceXml(input({ buyer: undefined }))).toThrow();
  });

  it("lists what a buyer is missing for ZATCA", () => {
    expect(buyerProblems(buyer)).toEqual([]);
    expect(
      buyerProblems({
        ...buyer,
        vatNumber: "12345",
        building: "12",
        postalCode: "1234",
        district: "",
      }),
    ).toEqual(["vatNumber", "building", "district", "postalCode"]);
    expect(
      buyerProblems({
        name: "Gulf Foods",
        vatNumber: null,
        otherId: { scheme: "OTH", id: "AE-1" },
        street: "Sheikh Zayed Rd",
        city: "Dubai",
        country: "AE",
      }),
    ).toEqual([]);
    expect(buyerProblems({ name: "X", street: "s", city: "c", country: "SA" })).toContain(
      "vatNumber",
    );
  });
});

describe("clearance answers", () => {
  it("reads ZATCA's answer and the cleared document's QR", () => {
    expect(clearOutcome(200, "<Invoice/>")).toBe("CLEARED");
    expect(clearOutcome(202, "<Invoice/>")).toBe("CLEARED_WITH_WARNINGS");
    expect(clearOutcome(200, null)).toBe("RETRY");
    expect(clearOutcome(400, null)).toBe("REJECTED");
    expect(clearOutcome(503, null)).toBe("RETRY");
    expect(clearOutcome(null, null)).toBe("RETRY");
    const cleared =
      '<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">AQ1RUg==</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>';
    expect(qrOf(cleared)).toBe("AQ1RUg==");
    expect(qrOf("<Invoice/>")).toBeNull();
  });
});
