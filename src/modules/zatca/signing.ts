import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  X509Certificate,
} from "node:crypto";
import {
  bits,
  children,
  explicit,
  implicitSet,
  integer,
  octets,
  oid,
  printable,
  read,
  seq,
  set,
  utf8,
} from "./der";
import { invoiceHash, invoiceXml, totals, type ZatcaInvoiceInput } from "./invoice";
import { phase1Qr, phase2Qr } from "./tlv";
import { el, leaf } from "./xml";

/**
 * Keys, certificate signing requests and the cryptographic stamp for ZATCA
 * Phase 2 (DECISIONS.md ADR-064): ECDSA on secp256k1, SHA-256, XAdES
 * signed properties, and the Phase 2 QR.
 *
 * NOT YET VALIDATED against ZATCA (sandbox not reachable from the
 * development environment). The known format details (hex-then-base64
 * digests, signing the hash bytes) follow the security standard.
 */

export function generateDeviceKey(): { privateKeyPem: string } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  return { privateKeyPem: privateKey.export({ type: "sec1", format: "pem" }).toString() };
}

/** Where the CSR is used: ZATCA's three environments use different certificate templates. */
export type ZatcaEnvironment = "developer-portal" | "simulation" | "core";

const TEMPLATE: Record<ZatcaEnvironment, string> = {
  "developer-portal": "TSTZATCA-Code-Signing",
  simulation: "PREZATCA-Code-Signing",
  core: "ZATCA-Code-Signing",
};

export interface CsrSubject {
  /** Device common name (unique per device). */
  commonName: string;
  /** Organization (taxpayer) name. */
  organization: string;
  /** Branch or unit name. */
  organizationUnit: string;
  /** "1-<solution>|2-<model or version>|3-<device serial>". */
  serialNumber: string;
  vatNumber: string;
  /** Invoice types the device issues: "1100" = standard and simplified, "0100" = simplified only. */
  invoiceTypes: string;
  address: string;
  businessCategory: string;
}

const name = (pairs: Array<[string, Buffer]>) => seq(...pairs.map(([o, v]) => set(seq(oid(o), v))));

/**
 * A PKCS#10 request with ZATCA's extensions (certificate template, and the
 * subject alternative name holding serial, VAT number, invoice types,
 * address and business category). Returned as ZATCA expects it: the PEM,
 * base64-encoded.
 */
export function buildCsr(
  privateKeyPem: string,
  subject: CsrSubject,
  env: ZatcaEnvironment,
): string {
  const key = createPrivateKey(privateKeyPem);
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const subjectName = name([
    ["2.5.4.6", printable("SA")],
    ["2.5.4.11", utf8(subject.organizationUnit)],
    ["2.5.4.10", utf8(subject.organization)],
    ["2.5.4.3", utf8(subject.commonName)],
  ]);
  const dirName = name([
    ["2.5.4.4", utf8(subject.serialNumber)], // SN (surname attribute, as ZATCA specifies)
    ["0.9.2342.19200300.100.1.1", utf8(subject.vatNumber)], // UID
    ["2.5.4.12", utf8(subject.invoiceTypes)], // title
    ["2.5.4.26", utf8(subject.address)], // registeredAddress
    ["2.5.4.15", utf8(subject.businessCategory)], // businessCategory
  ]);
  const extensions = seq(
    seq(oid("1.3.6.1.4.1.311.20.2"), octets(printable(TEMPLATE[env]))),
    seq(oid("2.5.29.17"), octets(seq(explicit(4, dirName)))),
  );
  const attributes = implicitSet(0, seq(oid("1.2.840.113549.1.9.14"), set(extensions)));
  const info = seq(integer(0), subjectName, spki, attributes);
  const signature = sign("sha256", info, key);
  const der = seq(info, seq(oid("1.2.840.10045.4.3.2")), bits(signature));
  const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${der
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .trim()}\n-----END CERTIFICATE REQUEST-----\n`;
  return Buffer.from(pem).toString("base64");
}

export interface CertificateInfo {
  /** The certificate body (base64 DER) as embedded in the signature. */
  body: string;
  /** base64(hex(SHA-256(body))) — ZATCA's certificate digest. */
  hash: string;
  issuer: string;
  serialNumber: string;
  /** SubjectPublicKeyInfo DER (QR tag 8). */
  publicKey: Buffer;
  /** The issuer's signature on the certificate (QR tag 9). */
  signature: Buffer;
}

/** Read the device certificate ZATCA issued (the CSID's binarySecurityToken, base64 of base64 DER). */
export function certificateInfo(certificateBody: string): CertificateInfo {
  const body = certificateBody.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, "");
  const der = Buffer.from(body, "base64");
  const x509 = new X509Certificate(der);
  const [, , signatureBits] = children(read(der));
  return {
    body,
    hash: Buffer.from(createHash("sha256").update(body).digest("hex")).toString("base64"),
    issuer: x509.issuer.split("\n").reverse().join(", "),
    serialNumber: BigInt(`0x${x509.serialNumber}`).toString(10),
    publicKey: x509.publicKey.export({ type: "spki", format: "der" }),
    signature: signatureBits.value.subarray(1),
  };
}

const XADES = "http://uri.etsi.org/01903/v1.3.2#";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";

function signedProperties(signingTime: string, cert: CertificateInfo, forDigest: boolean) {
  // For the digest, each ds: element declares its namespace (as when the
  // properties are canonicalised on their own); in the document they inherit it.
  const ds: Record<string, string> = forDigest ? { "xmlns:ds": DS } : {};
  return el(
    "xades:SignedProperties",
    forDigest
      ? { "xmlns:xades": XADES, Id: "xadesSignedProperties" }
      : { Id: "xadesSignedProperties" },
    el(
      "xades:SignedSignatureProperties",
      {},
      leaf("xades:SigningTime", signingTime),
      el(
        "xades:SigningCertificate",
        {},
        el(
          "xades:Cert",
          {},
          el(
            "xades:CertDigest",
            {},
            el("ds:DigestMethod", { ...ds, Algorithm: SHA256 }),
            leaf("ds:DigestValue", cert.hash, ds),
          ),
          el(
            "xades:IssuerSerial",
            {},
            leaf("ds:X509IssuerName", cert.issuer, ds),
            leaf("ds:X509SerialNumber", cert.serialNumber, ds),
          ),
        ),
      ),
    ),
  );
}

function ublExtensions(a: {
  invoiceHash: string;
  propertiesHash: string;
  signature: string;
  cert: CertificateInfo;
  signingTime: string;
}) {
  const xpath = (expr: string) =>
    el(
      "ds:Transform",
      { Algorithm: "http://www.w3.org/TR/1999/REC-xpath-19991116" },
      leaf("ds:XPath", expr),
    );
  return el(
    "ext:UBLExtensions",
    {},
    el(
      "ext:UBLExtension",
      {},
      leaf("ext:ExtensionURI", "urn:oasis:names:specification:ubl:dsig:enveloped:xades"),
      el(
        "ext:ExtensionContent",
        {},
        el(
          "sig:UBLDocumentSignatures",
          {
            "xmlns:sac":
              "urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2",
            "xmlns:sbc": "urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2",
            "xmlns:sig": "urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2",
          },
          el(
            "sac:SignatureInformation",
            {},
            leaf("cbc:ID", "urn:oasis:names:specification:ubl:signature:1"),
            leaf(
              "sbc:ReferencedSignatureID",
              "urn:oasis:names:specification:ubl:signature:Invoice",
            ),
            el(
              "ds:Signature",
              { "xmlns:ds": DS, Id: "signature" },
              el(
                "ds:SignedInfo",
                {},
                el("ds:CanonicalizationMethod", {
                  Algorithm: "http://www.w3.org/2006/12/xml-c14n11",
                }),
                el("ds:SignatureMethod", {
                  Algorithm: "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
                }),
                el(
                  "ds:Reference",
                  { Id: "invoiceSignedData", URI: "" },
                  el(
                    "ds:Transforms",
                    {},
                    xpath("not(//ancestor-or-self::ext:UBLExtensions)"),
                    xpath("not(//ancestor-or-self::cac:Signature)"),
                    xpath("not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])"),
                    el("ds:Transform", { Algorithm: "http://www.w3.org/2006/12/xml-c14n11" }),
                  ),
                  el("ds:DigestMethod", { Algorithm: SHA256 }),
                  leaf("ds:DigestValue", a.invoiceHash),
                ),
                el(
                  "ds:Reference",
                  {
                    Type: "http://www.w3.org/2000/09/xmldsig#SignatureProperties",
                    URI: "#xadesSignedProperties",
                  },
                  el("ds:DigestMethod", { Algorithm: SHA256 }),
                  leaf("ds:DigestValue", a.propertiesHash),
                ),
              ),
              leaf("ds:SignatureValue", a.signature),
              el("ds:KeyInfo", {}, el("ds:X509Data", {}, leaf("ds:X509Certificate", a.cert.body))),
              el(
                "ds:Object",
                {},
                el(
                  "xades:QualifyingProperties",
                  { "xmlns:xades": XADES, Target: "signature" },
                  signedProperties(a.signingTime, a.cert, false),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

export interface StampedInvoice {
  /** The signed XML (without declaration). */
  xml: string;
  invoiceHash: string;
  qr: string;
  signature: string | null;
}

/**
 * Stamp an invoice. With the device certificate: hash, sign, signed
 * properties, Phase 2 QR. Without one (device not onboarded yet): the hash
 * still chains the documents and the receipt carries the Phase 1 QR.
 */
export function stampInvoice(
  input: ZatcaInvoiceInput,
  device: { privateKeyPem: string; certificate: string } | null,
  signingTime: Date = new Date(),
): StampedInvoice {
  const hash = invoiceHash(invoiceXml(input));
  const t = totals(input.lines);
  const fields = {
    sellerName: input.seller.name,
    vatNumber: input.seller.vatNumber,
    timestamp: `${input.issueDate}T${input.issueTime}`,
    total: t.gross.toFixed(2),
    vat: t.vat.toFixed(2),
  };
  if (!device) {
    const qr = phase1Qr(fields);
    return { xml: invoiceXml(input), invoiceHash: hash, qr, signature: null };
  }
  const cert = certificateInfo(device.certificate);
  const signature = sign(
    "sha256",
    Buffer.from(hash, "base64"),
    createPrivateKey(device.privateKeyPem),
  ).toString("base64");
  const time = signingTime.toISOString().slice(0, 19);
  const propertiesHash = Buffer.from(
    createHash("sha256")
      .update(signedProperties(time, cert, true))
      .digest("hex"),
  ).toString("base64");
  const qr = phase2Qr({
    ...fields,
    invoiceHash: hash,
    signature,
    publicKey: cert.publicKey,
    certSignature: cert.signature,
  });
  const xml = invoiceXml(input, {
    ublExtensions: ublExtensions({
      invoiceHash: hash,
      propertiesHash,
      signature,
      cert,
      signingTime: time,
    }),
    qr,
  });
  return { xml, invoiceHash: hash, qr, signature };
}
