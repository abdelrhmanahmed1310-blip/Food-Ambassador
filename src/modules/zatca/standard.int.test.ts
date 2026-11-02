import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addSalesOrderLine,
  cancelSalesInvoice,
  confirmSalesOrder,
  createCustomer,
  createSalesOrder,
  deliverSalesOrder,
  getSalesOrder,
  invoiceDelivery,
  updateCustomerEInvoiceDetails,
} from "@/modules/b2b/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { qrOf, type Fetch } from "./client";
import { bits, children, explicit, integer, oid, read, seq, set, tlv, utf8 } from "./der";
import {
  clearSalesInvoice,
  getZatcaSetup,
  onboardDevice,
  prepareOfficeUnit,
  reportDueDocuments,
  salesInvoiceEInvoice,
  updateZatcaSettings,
} from "./service";

/**
 * SIMULATED ZATCA (ADR-072): standard invoices and clearance run against a
 * fake transport; the sandbox is not reachable from the development
 * environment. These tests check this application's flow, not ZATCA's
 * acceptance.
 */
const ca = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
function issueFor(csrBase64: string): string {
  const pem = Buffer.from(csrBase64, "base64").toString();
  const der = Buffer.from(pem.replace(/-----[^-]+-----|\n/g, ""), "base64");
  const [info] = children(read(der));
  const [, , spki] = children(info);
  const alg = seq(oid("1.2.840.10045.4.3.2"));
  const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), utf8(cn))));
  const time = (s: string) => tlv(0x17, Buffer.from(s));
  const tbs = seq(
    explicit(0, integer(2)),
    integer(BigInt(Date.now())),
    alg,
    name("Fake ZATCA CA"),
    seq(time("260101000000Z"), time("360101000000Z")),
    name("EGS"),
    spki.raw,
  );
  return Buffer.from(
    seq(tbs, alg, bits(sign("sha256", tbs, ca.privateKey))).toString("base64"),
  ).toString("base64");
}

const paths: string[] = [];
const submitted: string[] = [];
let clearAnswer: () => number = () => 200;
const fakeZatca: Fetch = async (url, init) => {
  const path = new URL(url).pathname.replace(/^\/e-invoicing\/[^/]+/, "");
  const headers = init.headers as Record<string, string>;
  const body = JSON.parse(String(init.body)) as Record<string, string>;
  paths.push(path);
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (path === "/compliance")
    return json(200, {
      requestID: 4321,
      binarySecurityToken: issueFor(body.csr),
      secret: "c-secret",
    });
  if (path === "/compliance/invoices") {
    submitted.push(Buffer.from(body.invoice, "base64").toString());
    return json(200, { validationResults: { status: "PASS" } });
  }
  if (path === "/production/csids") {
    const device = await getDb().zatcaDevice.findFirstOrThrow({
      where: { complianceRequestId: "4321" },
      orderBy: { createdAt: "desc" },
    });
    return json(200, {
      requestID: 8765,
      binarySecurityToken: issueFor(device.csr),
      secret: "p-secret",
    });
  }
  if (path === "/invoices/clearance/single") {
    expect(headers["Clearance-Status"]).toBe("1");
    const xml = Buffer.from(body.invoice, "base64").toString();
    submitted.push(xml);
    const status = clearAnswer();
    if (status === 400)
      return json(400, {
        validationResults: { errorMessages: [{ code: "BR-KSA-63", message: "Buyer address" }] },
      });
    if (status !== 200 && status !== 202) return json(status, {});
    // ZATCA stamps the document; here the "cleared" one carries a QR of its own.
    const cleared = xml.replace(
      /(<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>)[^<]+/,
      "$1Q0xFQVJFRC1RUg==",
    );
    return json(status, {
      clearanceStatus: "CLEARED",
      clearedInvoice: Buffer.from(cleared).toString("base64"),
    });
  }
  return json(404, {});
};

let ctx: TenantContext;
let ck: string;
let sauce: string;
let kg: string;
let complete: string;
let incomplete: string;

async function deliveredOrder(customerId: string, quantity = "2") {
  const order = await createSalesOrder(ctx, { customerId, warehouseId: ck });
  await addSalesOrderLine(ctx, order.id, {
    productId: sauce,
    quantity,
    uomId: kg,
    unitPrice: "50",
  });
  await confirmSalesOrder(ctx, order.id);
  const lineId = (await getSalesOrder(ctx, order.id)).lines[0].id;
  return deliverSalesOrder(ctx, order.id, { lines: [{ lineId, quantity }] });
}

beforeAll(async () => {
  ({ ctx } = await createTenant("zatca-b2b", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  kg = units.kg;
  const hq = (
    await createBranch(ctx, { code: "CK", name: "Central kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  ck = (
    await createWarehouse(ctx, { branchId: hq, code: "CK", name: "Central kitchen", type: "MAIN" })
  ).id;
  sauce = (
    await createProduct(ctx, {
      sku: "SAUCE",
      nameEn: "Tomato sauce",
      type: "FINISHED_GOOD",
      baseUomId: kg,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: ck,
    productId: sauce,
    quantity: "100",
    uomId: kg,
    unitCost: "30",
  });
  await applyCountryPreset(ctx, "SA");
  const codes = Object.fromEntries((await getTaxSetup(ctx)).codes.map((c) => [c.code, c.id]));
  await updateTaxSettings(ctx, {
    country: "SA",
    vatRegistered: "on",
    pricesIncludeTax: "on",
    vatNumber: "310122393500003",
    defaultSalesTaxCodeId: codes.STD,
    defaultPurchaseTaxCodeId: codes.STD,
  });
  await updateZatcaSettings(ctx, {
    legalName: "Central Kitchen Co",
    crNumber: "1010010000",
    street: "King Fahd Road",
    building: "1234",
    district: "Olaya",
    city: "Riyadh",
    postalCode: "12211",
    businessCategory: "Food production",
    environment: "DEVELOPER_PORTAL",
  });
  complete = (
    await createCustomer(ctx, {
      code: "HOTEL",
      name: "Riyadh Hotel Co",
      taxId: "300000000000003",
      street: "Olaya Street",
      buildingNumber: "4321",
      district: "Al Malaz",
      city: "Riyadh",
      postalCode: "12622",
    })
  ).id;
  incomplete = (
    await createCustomer(ctx, { code: "CAFE", name: "Corner Cafe", taxId: "300000000000003" })
  ).id;
}, 60_000);

afterAll(async () => {
  await getDb().$disconnect();
});

describe("B2B standard invoices with clearance (ADR-072)", () => {
  it("invoices as before until the back-office unit is onboarded", async () => {
    const d = await deliveredOrder(complete);
    const inv = await invoiceDelivery(ctx, d.id, { invoiceDate: businessDate(ctx.timeZone) });
    expect(await salesInvoiceEInvoice(ctx, inv.id)).toEqual([]);
  });

  it("onboards the back office's unit with standard samples", async () => {
    const { id } = await prepareOfficeUnit(ctx);
    const unit = await getDb().zatcaDevice.findUniqueOrThrow({ where: { id } });
    expect([unit.purpose, unit.registerId, unit.commonName]).toEqual([
      "OFFICE",
      null,
      "EGS-OFFICE",
    ]);
    submitted.length = 0;
    expect(await onboardDevice(ctx, id, { otp: "123456" }, fakeZatca)).toBe("ACTIVE");
    // Three standard samples, each with a buyer.
    expect(submitted).toHaveLength(3);
    for (const xml of submitted) {
      expect(xml).toContain('name="0100000"');
      expect(xml).toContain("<cac:AccountingCustomerParty>");
    }
    expect((await getZatcaSetup(ctx)).office?.status).toBe("ACTIVE");
    await expectAppError(prepareOfficeUnit(ctx), "BUSINESS_RULE_VIOLATION");
  });

  it("refuses to invoice a buyer whose details ZATCA would reject, or another date", async () => {
    const d = await deliveredOrder(incomplete);
    await expectAppError(
      invoiceDelivery(ctx, d.id, { invoiceDate: businessDate(ctx.timeZone) }),
      "BUSINESS_RULE_VIOLATION",
    );
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const d2 = await deliveredOrder(complete);
    await expectAppError(
      invoiceDelivery(ctx, d2.id, { invoiceDate: yesterday }),
      "BUSINESS_RULE_VIOLATION",
    );
    // Completing the customer's details lets it through.
    await expectAppError(
      updateCustomerEInvoiceDetails(ctx, incomplete, { buildingNumber: "12" }),
      "VALIDATION_FAILED",
    );
    await updateCustomerEInvoiceDetails(ctx, incomplete, {
      taxId: "300000000000003",
      street: "Tahlia Street",
      buildingNumber: "1111",
      district: "Al Sulimaniyah",
      city: "Riyadh",
      postalCode: "12241",
    });
    const inv = await invoiceDelivery(ctx, d.id, { invoiceDate: businessDate(ctx.timeZone) });
    expect((await salesInvoiceEInvoice(ctx, inv.id))[0].status).toBe("PENDING");
  });

  it("clears an invoice with ZATCA and keeps the cleared document and its QR", async () => {
    const d = await deliveredOrder(complete, "3");
    const inv = await invoiceDelivery(ctx, d.id, { invoiceDate: businessDate(ctx.timeZone) });
    const [pending] = await salesInvoiceEInvoice(ctx, inv.id);
    expect(pending).toMatchObject({ type: "INVOICE", status: "PENDING" });
    const doc = await getDb().zatcaDocument.findFirstOrThrow({ where: { salesInvoiceId: inv.id } });
    expect(doc.xml).toContain("<cbc:CompanyID>300000000000003</cbc:CompanyID>");
    expect(doc.xml).toContain("<cbc:ActualDeliveryDate>");
    // 3 kg × 50 = 150 + VAT 22.50.
    expect(doc.xml).toContain('<cbc:TaxAmount currencyID="SAR">22.50</cbc:TaxAmount>');

    paths.length = 0;
    await clearSalesInvoice(ctx, inv.id, fakeZatca);
    expect(paths).toEqual(["/invoices/clearance/single"]);
    const cleared = await getDb().zatcaDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(cleared.status).toBe("CLEARED");
    expect(cleared.reportedAt).not.toBeNull();
    expect(cleared.qr).toBe("Q0xFQVJFRC1RUg==");
    expect(qrOf(cleared.clearedXml!)).toBe(cleared.qr);
    // The signed original never changes.
    expect(cleared.xml).toBe(doc.xml);
  });

  it("keeps a rejection for review, and retries when ZATCA does not answer", async () => {
    const d = await deliveredOrder(complete);
    const inv = await invoiceDelivery(ctx, d.id, { invoiceDate: businessDate(ctx.timeZone) });
    clearAnswer = () => 503;
    await clearSalesInvoice(ctx, inv.id, fakeZatca);
    let [doc] = await salesInvoiceEInvoice(ctx, inv.id);
    expect([doc.status, doc.attempts]).toEqual(["PENDING", 1]);
    clearAnswer = () => 400;
    await clearSalesInvoice(ctx, inv.id, fakeZatca); // "Clear now" ignores the back-off
    [doc] = await salesInvoiceEInvoice(ctx, inv.id);
    expect(doc.status).toBe("REJECTED");
    expect(JSON.stringify(doc.response)).toContain("BR-KSA-63");
    clearAnswer = () => 200;
  });

  it("corrects a cancelled invoice with a cleared standard credit note", async () => {
    const d = await deliveredOrder(complete);
    const inv = await invoiceDelivery(ctx, d.id, { invoiceDate: businessDate(ctx.timeZone) });
    await clearSalesInvoice(ctx, inv.id, fakeZatca);
    await cancelSalesInvoice(ctx, inv.id, { reason: "Wrong price" });
    await clearSalesInvoice(ctx, inv.id, fakeZatca);
    const docs = await salesInvoiceEInvoice(ctx, inv.id);
    expect(docs.map((x) => [x.type, x.status])).toEqual([
      ["INVOICE", "CLEARED"],
      ["CREDIT_NOTE", "CLEARED"],
    ]);
    const note = await getDb().zatcaDocument.findFirstOrThrow({
      where: { salesInvoiceId: inv.id, type: "CREDIT_NOTE" },
    });
    expect(note.xml).toContain('<cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>');
    expect(note.xml).toContain(
      `<cbc:ID>${(await getDb().salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).number}</cbc:ID>`,
    );
  });

  it("is cleared by the scheduled job too, and kept to its organization", async () => {
    const d = await deliveredOrder(complete);
    const inv = await invoiceDelivery(ctx, d.id, { invoiceDate: businessDate(ctx.timeZone) });
    await reportDueDocuments({ organizationId: ctx.organizationId, fetchImpl: fakeZatca });
    expect((await salesInvoiceEInvoice(ctx, inv.id))[0].status).toBe("CLEARED");
    const other = (
      await createTenant("zatca-b2b-other", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" })
    ).ctx;
    expect(await salesInvoiceEInvoice(other, inv.id)).toEqual([]);
    expect(await clearSalesInvoice(other, inv.id, fakeZatca)).toEqual([]);
    const viewer = (await addMember(ctx, "waiter")).ctx;
    await expectAppError(clearSalesInvoice(viewer, inv.id, fakeZatca), "FORBIDDEN");
  });
});
