import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import {
  createRegister,
  getOrder,
  openShift,
  refundOrder,
  submitOrder,
  voidOrder,
} from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import type { Fetch } from "./client";
import { bits, children, explicit, integer, oid, read, seq, set, tlv, utf8 } from "./der";
import { FIRST_PIH, invoiceHash } from "./invoice";
import {
  getZatcaSetup,
  onboardDevice,
  prepareDevice,
  reportDueDocuments,
  updateZatcaSettings,
} from "./service";
import { decodeTlv } from "./tlv";

/**
 * SIMULATED ZATCA: these tests run the onboarding and reporting flows
 * against a fake transport (the sandbox is not reachable from the
 * development environment). They check this application's behaviour —
 * states, chain, signatures, retries — not ZATCA's acceptance.
 */
const ca = generateKeyPairSync("ec", { namedCurve: "secp256k1" });

/** A certificate for the CSR's public key, issued by the fake CA (as ZATCA would). */
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
  const cert = seq(tbs, alg, bits(sign("sha256", tbs, ca.privateKey)));
  return Buffer.from(cert.toString("base64")).toString("base64");
}

const calls: Array<{
  path: string;
  headers: Record<string, string>;
  body: Record<string, string>;
}> = [];
let reportAnswer: (uuid: string) => number = () => 200;

const fakeZatca: Fetch = async (url, init) => {
  const path = new URL(url).pathname.replace(/^\/e-invoicing\/[^/]+/, "");
  const headers = init.headers as Record<string, string>;
  const body = JSON.parse(String(init.body)) as Record<string, string>;
  calls.push({ path, headers, body });
  const json = (status: number, b: unknown) =>
    new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  if (path === "/compliance") {
    if (headers.OTP !== "123345") return json(400, { errorCode: "Invalid-OTP" });
    return json(200, {
      requestID: 1234,
      binarySecurityToken: issueFor(body.csr),
      secret: "compliance-secret",
    });
  }
  if (path === "/compliance/invoices") return json(200, { validationResults: { status: "PASS" } });
  if (path === "/production/csids") {
    const device = await getDb().zatcaDevice.findFirstOrThrow({
      where: { complianceRequestId: "1234" },
      orderBy: { createdAt: "desc" },
    });
    return json(200, {
      requestID: 5678,
      binarySecurityToken: issueFor(device.csr),
      secret: "production-secret",
    });
  }
  if (path === "/invoices/reporting/single") {
    const status = reportAnswer(body.uuid);
    return json(
      status,
      status === 400 ? { validationResults: { errorMessages: ["BR-KSA-XX"] } } : {},
    );
  }
  return json(404, {});
};

let ctx: TenantContext;
let register: string;
let burger: string;

const sale = () =>
  submitOrder(ctx, {
    orderId: randomUUID(),
    registerId: register,
    channel: "DINE_IN",
    lines: [{ itemId: burger, quantity: "2", optionIds: [] }],
    payments: [{ method: "CARD", amount: "230" }],
  });

beforeAll(async () => {
  ({ ctx } = await createTenant("zatca", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
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
  const branchId = (
    await createBranch(ctx, {
      code: "RUH",
      name: "Riyadh",
      type: "RESTAURANT",
      timeZone: "Asia/Riyadh",
    })
  ).id;
  const kitchen = (
    await createWarehouse(ctx, { branchId, code: "K", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const patty = (
    await createProduct(ctx, {
      sku: "PATTY",
      nameEn: "Patty",
      type: "FINISHED_GOOD",
      baseUomId: units.each,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: kitchen,
    productId: patty,
    quantity: "100",
    uomId: units.each,
    unitCost: "10",
  });
  const cat = (await createMenuCategory(ctx, { name: "Mains" })).id;
  burger = (
    await createMenuItem(ctx, {
      code: "BURGER",
      name: "Burger",
      categoryId: cat,
      kind: "ITEM",
      productId: patty,
    })
  ).id;
  await addMenuItemPrice(ctx, burger, {
    channel: "DINE_IN",
    price: "115",
    effectiveFrom: businessDate(ctx.timeZone),
  });
  register = (
    await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL1", name: "Till" })
  ).id;
  await openShift(ctx, register, { openingFloat: "0" });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("before onboarding (ADR-064)", () => {
  it("prints the Phase 1 QR on receipts and keeps no e-invoice", async () => {
    const o = await sale();
    const order = await getOrder(ctx, o.id);
    expect(order.eInvoice?.signed).toBe(false);
    const qr = decodeTlv(order.eInvoice!.qr);
    expect([...qr.keys()]).toEqual([1, 2, 3, 4, 5]);
    expect(qr.get(2)?.toString()).toBe("310122393500003");
    expect(qr.get(4)?.toString()).toBe("230.00");
    expect(qr.get(5)?.toString()).toBe("30.00");
    expect(qr.get(3)?.toString()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    expect(
      await getDb().zatcaDocument.count({ where: { organizationId: ctx.organizationId } }),
    ).toBe(0);
  });

  it("is for organizations reporting in Saudi riyals", async () => {
    const egypt = (await createTenant("zatca-egp")).ctx;
    await expectAppError(
      updateZatcaSettings(egypt, {
        legalName: "X",
        street: "S",
        building: "1234",
        district: "D",
        city: "C",
        postalCode: "12345",
        businessCategory: "B",
        environment: "DEVELOPER_PORTAL",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("needs the seller's details before a unit can be prepared", async () => {
    await expectAppError(prepareDevice(ctx, register), "BUSINESS_RULE_VIOLATION");
    await expectAppError(
      updateZatcaSettings(ctx, {
        legalName: "Food Co",
        street: "King Fahd Road",
        building: "12",
        district: "Olaya",
        city: "Riyadh",
        postalCode: "12211",
        businessCategory: "Restaurants",
        environment: "DEVELOPER_PORTAL",
      }),
      "VALIDATION_FAILED", // building number has 4 digits
    );
    await updateZatcaSettings(ctx, {
      legalName: "Food Co",
      crNumber: "1010010000",
      street: "King Fahd Road",
      building: "1234",
      district: "Olaya",
      city: "Riyadh",
      postalCode: "12211",
      businessCategory: "Restaurants",
      environment: "DEVELOPER_PORTAL",
    });
    const waiter = (await addMember(ctx, "waiter")).ctx;
    await expectAppError(getZatcaSetup(waiter), "FORBIDDEN");
  });
});

describe("onboarding a unit (simulated ZATCA)", () => {
  it("prepares a key and CSR, stops on a wrong OTP, then onboards", async () => {
    const { id } = await prepareDevice(ctx, register);
    const device = await getDb().zatcaDevice.findUniqueOrThrow({ where: { id } });
    expect(device.status).toBe("NEW");
    expect(device.privateKeySealed).toMatch(/^v1\./); // sealed, never the PEM
    expect(device.privateKeySealed).not.toContain("PRIVATE KEY");
    expect(Buffer.from(device.csr, "base64").toString()).toContain("BEGIN CERTIFICATE REQUEST");
    await expectAppError(
      onboardDevice(ctx, id, { otp: "000000" }, fakeZatca),
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await getDb().zatcaDevice.findUniqueOrThrow({ where: { id } })).status).toBe("NEW");
    await expectAppError(onboardDevice(ctx, id, { otp: "12a" }, fakeZatca), "VALIDATION_FAILED");

    calls.length = 0;
    expect(await onboardDevice(ctx, id, { otp: "123345" }, fakeZatca)).toBe("ACTIVE");
    expect(calls.map((c) => c.path)).toEqual([
      "/compliance",
      "/compliance/invoices",
      "/compliance/invoices",
      "/compliance/invoices",
      "/production/csids",
    ]);
    expect(calls[0].headers["Accept-Version"]).toBe("V2");
    // The samples sent are signed documents whose hash matches.
    const samples = calls.filter((c) => c.path === "/compliance/invoices");
    expect(
      samples.map(
        (c) =>
          /<cbc:InvoiceTypeCode name="0200000">(\d+)</.exec(
            Buffer.from(c.body.invoice, "base64").toString(),
          )?.[1],
      ),
    ).toEqual(["388", "381", "383"]);
    for (const c of samples) {
      const xml = Buffer.from(c.body.invoice, "base64").toString();
      const pure = xml
        .replace(/^<\?xml[^>]*>\n/, "")
        .replace(/<ext:UBLExtensions>.*<\/ext:UBLExtensions>/, "")
        .replace(/<cac:Signature>.*?<\/cac:Signature>/, "")
        .replace(
          /<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>.*?<\/cac:AdditionalDocumentReference>/,
          "",
        );
      expect(invoiceHash(pure)).toBe(c.body.invoiceHash);
    }
    const active = await getDb().zatcaDevice.findUniqueOrThrow({ where: { id } });
    expect(active.productionSecret).toMatch(/^v1\./);
    expect(active.onboardedAt).not.toBeNull();
  });
});

describe("issuing and reporting", () => {
  it("signs every sale, refund and void in one chain and prints the signed QR", async () => {
    const a = await sale();
    const b = await sale();
    const docs = await getDb().zatcaDocument.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { icv: "asc" },
    });
    expect(docs.map((d) => [d.type, d.icv])).toEqual([
      ["INVOICE", 1],
      ["INVOICE", 2],
    ]);
    expect(docs[0].pih).toBe(FIRST_PIH);
    expect(docs[1].pih).toBe(docs[0].invoiceHash);
    const device = await getDb().zatcaDevice.findFirstOrThrow({ where: { registerId: register } });
    expect(device.icv).toBe(2);
    expect(device.lastHash).toBe(docs[1].invoiceHash);

    const order = await getOrder(ctx, a.id);
    expect(order.eInvoice?.signed).toBe(true);
    const qr = decodeTlv(order.eInvoice!.qr);
    expect([...qr.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(qr.get(6)?.toString()).toBe(docs[0].invoiceHash);
    // The signature in the QR verifies with the public key in the QR.
    const publicKey = createPublicKey({ key: qr.get(8)!, format: "der", type: "spki" });
    expect(
      verify(
        "sha256",
        Buffer.from(docs[0].invoiceHash, "base64"),
        publicKey,
        Buffer.from(qr.get(7)!.toString(), "base64"),
      ),
    ).toBe(true);
    expect(docs[0].xml).toContain("<cbc:CompanyID>310122393500003</cbc:CompanyID>");
    expect(docs[0].xml).toContain(
      '<cbc:TaxInclusiveAmount currencyID="SAR">230.00</cbc:TaxInclusiveAmount>',
    );
    expect(docs[0].xml).toContain("<cbc:PaymentMeansCode>48</cbc:PaymentMeansCode>");

    const line = order.lines[0];
    await refundOrder(ctx, a.id, {
      registerId: register,
      method: "CASH",
      reason: "Cold",
      lines: [{ orderLineId: line.id, quantity: "1" }],
    });
    await voidOrder(ctx, b.id, { reason: "Wrong order" });
    const notes = await getDb().zatcaDocument.findMany({
      where: { organizationId: ctx.organizationId, type: "CREDIT_NOTE" },
      orderBy: { icv: "asc" },
    });
    expect(notes.map((n) => n.icv)).toEqual([3, 4]);
    expect(notes[0].xml).toContain(
      `<cac:InvoiceDocumentReference><cbc:ID>${order.number}</cbc:ID>`,
    );
    expect(notes[0].xml).toContain("<cbc:InstructionNote>Cold</cbc:InstructionNote>");
    expect(notes[0].xml).toContain(
      '<cbc:TaxInclusiveAmount currencyID="SAR">115.00</cbc:TaxInclusiveAmount>',
    );
    expect(notes[0].xml).toContain("<cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>");
    expect(notes[1].xml).toContain(
      '<cbc:TaxInclusiveAmount currencyID="SAR">230.00</cbc:TaxInclusiveAmount>',
    );
    expect(notes[1].pih).toBe(notes[0].invoiceHash);
  });

  it("reports due documents, keeps rejections and retries without an answer", async () => {
    const docs = await getDb().zatcaDocument.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { icv: "asc" },
    });
    const answer = new Map([
      [docs[0].uuid, 200],
      [docs[1].uuid, 202],
      [docs[2].uuid, 400],
      [docs[3].uuid, 503],
    ]);
    reportAnswer = (uuid) => answer.get(uuid) ?? 503;
    await reportDueDocuments({ fetchImpl: fakeZatca, limit: 1000 });
    const after = await getDb().zatcaDocument.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { icv: "asc" },
    });
    expect(after.map((d) => d.status)).toEqual([
      "REPORTED",
      "REPORTED_WITH_WARNINGS",
      "REJECTED",
      "PENDING",
    ]);
    expect(after[3].attempts).toBe(1);
    expect(after[3].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(after[2].response).toMatchObject({
      validationResults: { errorMessages: ["BR-KSA-XX"] },
    });
    const reported = calls.filter((c) => c.path === "/invoices/reporting/single");
    expect(reported[0].headers.Authorization).toMatch(/^Basic /);
    // A signed document cannot change or be deleted.
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.zatcaDocument.update({ where: { id: docs[0].id }, data: { xml: "<x/>" } }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.zatcaDocument.delete({ where: { id: docs[0].id } }),
      ),
    ).rejects.toThrow();
    const setup = await getZatcaSetup(ctx);
    expect(setup.counts).toMatchObject({ REPORTED: 1, REJECTED: 1, PENDING: 1 });
    const other = (await createTenant("zatca-other")).ctx;
    expect((await getZatcaSetup(other)).documents).toHaveLength(0);
    expect(createPrivateKey).toBeDefined();
  });
});
