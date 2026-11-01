import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import {
  bits,
  children,
  explicit,
  integer,
  oid,
  printable,
  read,
  seq,
  set,
  tlv,
  utf8,
} from "./der";
import { FIRST_PIH, invoiceHash, invoiceXml, type ZatcaInvoiceInput } from "./invoice";
import { buildCsr, certificateInfo, generateDeviceKey, stampInvoice } from "./signing";
import { decodeTlv, phase1Qr } from "./tlv";

const d = (v: string) => new Decimal(v);

/** A self-signed secp256k1 certificate for tests (ZATCA issues the real one). */
function testCertificate(privateKeyPem: string) {
  const key = createPrivateKey(privateKeyPem);
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const name = seq(set(seq(oid("2.5.4.3"), utf8("TEST-EGS"))));
  const time = (s: string) => tlv(0x17, Buffer.from(s));
  const alg = seq(oid("1.2.840.10045.4.3.2"));
  const tbs = seq(
    explicit(0, integer(2)),
    integer(1234567890123n),
    alg,
    name,
    seq(time("260101000000Z"), time("360101000000Z")),
    name,
    spki,
  );
  const der = seq(tbs, alg, bits(sign("sha256", tbs, key)));
  return der.toString("base64");
}

const input = (over: Partial<ZatcaInvoiceInput> = {}): ZatcaInvoiceInput => ({
  type: "INVOICE",
  number: "POS-2026-000001",
  uuid: "6f4d20e0-6bfe-4a80-9389-7dabe6620f12",
  issueDate: "2026-11-01",
  issueTime: "13:45:10",
  icv: 1,
  pih: FIRST_PIH,
  currency: "SAR",
  seller: {
    name: "Food & Co <Riyadh>",
    vatNumber: "310122393500003",
    crNumber: "1010010000",
    street: "King Fahd Road",
    building: "1234",
    district: "Al Olaya",
    city: "Riyadh",
    postalCode: "12211",
  },
  paymentMeans: "48",
  lines: [
    {
      name: "Burger",
      quantity: d("2"),
      net: d("200"),
      vat: d("30"),
      category: "S",
      percent: d("15"),
    },
    {
      name: "Water",
      quantity: d("1"),
      net: d("10"),
      vat: d("1.5"),
      category: "S",
      percent: d("15"),
    },
  ],
  ...over,
});

describe("ZATCA QR (ADR-064)", () => {
  it("encodes the Phase 1 fields as in ZATCA's QR guideline example", () => {
    const qr = phase1Qr({
      sellerName: "Bobs Records",
      vatNumber: "310122393500003",
      timestamp: "2022-04-25T15:30:00Z",
      total: "1000.00",
      vat: "150.00",
    });
    expect(qr).toBe(
      "AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==",
    );
    expect(decodeTlv(qr).get(1)?.toString()).toBe("Bobs Records");
  });
  it("encodes Arabic names in UTF-8 and refuses fields over 255 bytes", () => {
    const qr = phase1Qr({
      sellerName: "مطعم السفير",
      vatNumber: "3",
      timestamp: "t",
      total: "1",
      vat: "0",
    });
    expect(decodeTlv(qr).get(1)?.toString("utf8")).toBe("مطعم السفير");
    expect(() =>
      phase1Qr({
        sellerName: "x".repeat(256),
        vatNumber: "3",
        timestamp: "t",
        total: "1",
        vat: "0",
      }),
    ).toThrow(RangeError);
  });
});

describe("ZATCA invoice XML and stamp", () => {
  it("writes canonical XML with totals per VAT category and escapes text", () => {
    const xml = invoiceXml(input());
    expect(
      xml.startsWith('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"'),
    ).toBe(true);
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:TaxableAmount currencyID="SAR">210.00</cbc:TaxableAmount>');
    expect(xml).toContain(
      '<cbc:TaxInclusiveAmount currencyID="SAR">241.50</cbc:TaxInclusiveAmount>',
    );
    expect(xml).toContain("Food &amp; Co &lt;Riyadh&gt;");
    expect(xml).not.toMatch(/>\s+</); // no whitespace between elements
    expect(xml).not.toContain("/>"); // no self-closing tags
    expect(xml).not.toContain("UBLExtensions");
  });

  it("writes a credit note referencing the invoice with its reason", () => {
    const xml = invoiceXml(
      input({ type: "CREDIT_NOTE", billingReference: "POS-2026-000001", reason: "Cold food" }),
    );
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">381</cbc:InvoiceTypeCode>');
    expect(xml).toContain("<cac:InvoiceDocumentReference><cbc:ID>POS-2026-000001</cbc:ID>");
    expect(xml).toContain("<cbc:InstructionNote>Cold food</cbc:InstructionNote>");
  });

  it("signs the hash of the invoice without stamp, signature reference and QR", () => {
    const { privateKeyPem } = generateDeviceKey();
    const certificate = testCertificate(privateKeyPem);
    const stamped = stampInvoice(
      input(),
      { privateKeyPem, certificate },
      new Date("2026-11-01T10:45:11Z"),
    );
    // What ZATCA removes before hashing gives back exactly the pure invoice.
    const removed = stamped.xml
      .replace(/<ext:UBLExtensions>.*<\/ext:UBLExtensions>/, "")
      .replace(/<cac:Signature>.*?<\/cac:Signature>/, "")
      .replace(
        /<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>.*?<\/cac:AdditionalDocumentReference>/,
        "",
      );
    expect(removed).toBe(invoiceXml(input()));
    expect(invoiceHash(removed)).toBe(stamped.invoiceHash);
    const publicKey = createPublicKey(createPrivateKey(privateKeyPem));
    expect(
      verify(
        "sha256",
        Buffer.from(stamped.invoiceHash, "base64"),
        publicKey,
        Buffer.from(stamped.signature!, "base64"),
      ),
    ).toBe(true);
    const qr = decodeTlv(stamped.qr);
    expect([...qr.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(qr.get(3)?.toString()).toBe("2026-11-01T13:45:10");
    expect(qr.get(4)?.toString()).toBe("241.50");
    expect(qr.get(6)?.toString()).toBe(stamped.invoiceHash);
    expect(qr.get(8)).toEqual(publicKey.export({ type: "spki", format: "der" }));
    expect(stamped.xml).toContain(
      "<ds:SigningTime>".replace("ds", "xades") + "2026-11-01T10:45:11",
    );
  });

  it("chains the hash and uses only the Phase 1 QR before the device is onboarded", () => {
    const first = stampInvoice(input(), null);
    expect(first.signature).toBeNull();
    expect([...decodeTlv(first.qr).keys()]).toEqual([1, 2, 3, 4, 5]);
    const second = invoiceXml(input({ icv: 2, pih: first.invoiceHash, number: "POS-2026-000002" }));
    expect(second).toContain(
      `<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${first.invoiceHash}<`,
    );
    expect(FIRST_PIH).toBe(
      "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==",
    );
  });
});

describe("certificates and requests", () => {
  it("reads issuer, serial, public key and signature from a certificate", () => {
    const { privateKeyPem } = generateDeviceKey();
    const info = certificateInfo(testCertificate(privateKeyPem));
    expect(info.issuer).toBe("CN=TEST-EGS");
    expect(info.serialNumber).toBe("1234567890123");
    expect(info.signature.length).toBeGreaterThan(60);
    expect(Buffer.from(info.hash, "base64").toString()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds a signed CSR with ZATCA's template and subject alternative name", () => {
    const { privateKeyPem } = generateDeviceKey();
    const csr = buildCsr(
      privateKeyPem,
      {
        commonName: "EGS-TILL1",
        organization: "Food Co",
        organizationUnit: "Riyadh",
        serialNumber: "1-FoodAmbassador|2-1.0|3-6f4d20e0",
        vatNumber: "310122393500003",
        invoiceTypes: "1100",
        address: "King Fahd Road, Riyadh",
        businessCategory: "Restaurants",
      },
      "developer-portal",
    );
    const pem = Buffer.from(csr, "base64").toString();
    expect(pem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----\n/);
    const der = Buffer.from(pem.replace(/-----[^-]+-----|\n/g, ""), "base64");
    const [info, , signature] = children(read(der));
    const publicKey = createPublicKey(createPrivateKey(privateKeyPem));
    expect(verify("sha256", info.raw, publicKey, signature.value.subarray(1))).toBe(true);
    const text = der.toString("latin1");
    expect(text).toContain("TSTZATCA-Code-Signing");
    expect(text).toContain("310122393500003");
    expect(text).toContain("1-FoodAmbassador|2-1.0|3-6f4d20e0");
    expect(printable("SA").length).toBe(4);
  });
});
