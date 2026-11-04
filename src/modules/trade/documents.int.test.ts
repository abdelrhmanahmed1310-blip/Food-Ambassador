import { beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { addOrderLine, createOrder, submitOrder } from "@/modules/procurement/orders";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addProductDocument,
  addShipmentDocument,
  archiveTradeDocument,
  createDocumentType,
  createRequirement,
  listTradeDocuments,
  renewTradeDocument,
  tradeSetup,
} from "./documents";
import { advanceShipment, createShipment, getShipment, linkOrder } from "./shipments";

/** Trade documents, requirements and the shipment checklist (ADR-114). */

let ctx: TenantContext;
let buyer: TenantContext;
let today: string;
let warehouseId: string;
let shipmentId: string;
let milk: string;
const types: Record<string, string> = {};

async function expectRule(promise: Promise<unknown>, rule: string) {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; details?: { rule?: string } };
    expect(`${e.code}:${e.details?.rule}`).toBe(`BUSINESS_RULE_VIOLATION:${rule}`);
    return;
  }
  throw new Error(`Expected ${rule} but the call succeeded`);
}

const states = async () =>
  (await getShipment(buyer, shipmentId)).checklist.lines.map((l) => [
    l.documentType.code,
    l.product?.sku ?? null,
    l.state,
  ]);

beforeAll(async () => {
  ({ ctx } = await createTenant("trade-docs"));
  buyer = (await addMember(ctx, "procurement")).ctx;
  today = businessDate(ctx.timeZone);
  await getDb().company.updateMany({
    where: { organizationId: ctx.organizationId },
    data: { country: "SA" },
  });
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (
    await createBranch(ctx, { code: "JED", name: "Jeddah", type: "CENTRAL_KITCHEN" })
  ).id;
  warehouseId = (await createWarehouse(ctx, { branchId, code: "DC", name: "DC", type: "MAIN" })).id;
  milk = (
    await createProduct(ctx, {
      sku: "MILK",
      nameEn: "Milk powder",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
      hsCode: "04022110",
      originCountry: "NZ",
    })
  ).id;
  const beef = (
    await createProduct(ctx, {
      sku: "BEEF",
      nameEn: "Beef",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
      hsCode: "020230",
    })
  ).id;
  const supplierId = (await createSupplier(ctx, { code: "OCEANIA", name: "Oceania Foods" })).id;
  const { id: orderId } = await createOrder(buyer, { supplierId, warehouseId });
  for (const productId of [milk, beef])
    await addOrderLine(buyer, orderId, {
      productId,
      uomId: units.kg,
      quantity: "100",
      unitPrice: "10",
    });
  await submitOrder(buyer, orderId);
  shipmentId = (await createShipment(buyer, { supplierId, warehouseId, mode: "SEA" })).id;
  await linkOrder(buyer, shipmentId, { purchaseOrderId: orderId });

  for (const [code, name, scope, hasExpiry] of [
    ["INV", "Commercial invoice", "SHIPMENT", false],
    ["HEALTH", "Health certificate", "SHIPMENT", true],
    ["REG", "Product registration", "PRODUCT", true],
  ] as const)
    types[code] = (
      await createDocumentType(buyer, { code, name, scope, hasExpiry: String(hasExpiry) })
    ).id;
  await createRequirement(buyer, { documentTypeId: types.INV });
  await createRequirement(buyer, {
    documentTypeId: types.HEALTH,
    destinationCountry: "SA",
    hsPrefix: "04",
    authority: "SFDA",
  });
  await createRequirement(buyer, {
    documentTypeId: types.REG,
    destinationCountry: "sa",
    hsPrefix: "0402",
  });
  // Into Egypt only: not this shipment.
  await createRequirement(buyer, { documentTypeId: types.HEALTH, destinationCountry: "EG" });
}, 60_000);

describe("trade documents (ADR-114)", () => {
  it("is set up by the organization: its own types and requirements", async () => {
    await expectAppError(
      createDocumentType(buyer, { code: "inv", name: "x", scope: "SHIPMENT" }),
      "CONFLICT",
    );
    await expectAppError(
      createRequirement(buyer, { documentTypeId: types.INV, hsPrefix: "4" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createRequirement(buyer, { documentTypeId: types.INV, originCountry: "XX" }),
      "VALIDATION_FAILED",
    );
    const setup = await tradeSetup(buyer);
    expect([setup.types.length, setup.requirements.length]).toEqual([3, 4]);
  });

  it("lists what the shipment needs, and names products it cannot match", async () => {
    expect(await states()).toEqual([
      ["INV", null, "MISSING"],
      ["HEALTH", null, "MISSING"],
      ["REG", "MILK", "MISSING"],
    ]);
    const check = (await getShipment(buyer, shipmentId)).checklist;
    expect([check.destinationKnown, check.withoutHsCode, check.withoutOrigin]).toEqual([
      true,
      [],
      ["BEEF"],
    ]);
  });

  it("refuses customs clearance until every required document is held and in date", async () => {
    await advanceShipment(buyer, shipmentId);
    await advanceShipment(buyer, shipmentId);
    await expectRule(advanceShipment(buyer, shipmentId), "SHIPMENT_DOCUMENTS_MISSING");

    await addShipmentDocument(buyer, shipmentId, {
      documentTypeId: types.INV,
      number: "CI-2026-118",
    });
    await expectRule(
      addShipmentDocument(buyer, shipmentId, { documentTypeId: types.HEALTH }),
      "DOCUMENT_NEEDS_EXPIRY",
    );
    await expectRule(
      addShipmentDocument(buyer, shipmentId, { documentTypeId: types.REG, expiresOn: today }),
      "DOCUMENT_TYPE_OTHER_SCOPE",
    );
    await expectAppError(
      addShipmentDocument(buyer, shipmentId, {
        documentTypeId: types.HEALTH,
        issuedOn: today,
        expiresOn: addDays(today, -1),
      }),
      "VALIDATION_FAILED",
    );
    const health = await addShipmentDocument(buyer, shipmentId, {
      documentTypeId: types.HEALTH,
      number: "MPI-77",
      issuedBy: "MPI New Zealand",
      expiresOn: addDays(today, -1),
    });
    await addProductDocument(buyer, {
      documentTypeId: types.REG,
      productId: milk,
      number: "SFDA-123",
      expiresOn: addDays(today, 200),
    });
    expect(await states()).toEqual([
      ["INV", null, "OK"],
      ["HEALTH", null, "EXPIRED"],
      ["REG", "MILK", "OK"],
    ]);
    await expectRule(advanceShipment(buyer, shipmentId), "SHIPMENT_DOCUMENTS_MISSING");
    expect(
      (await attentionItems(buyer)).find((i) => i.key === "TRADE_DOCUMENTS_EXPIRED")?.count,
    ).toBe(1);

    // Renewed: in date, but within 30 days of expiry.
    await renewTradeDocument(buyer, health.id, { number: "MPI-78", expiresOn: addDays(today, 10) });
    expect((await states())[1]).toEqual(["HEALTH", null, "EXPIRING"]);
    expect((await listTradeDocuments(buyer, { state: "EXPIRING" })).map((d) => d.number)).toEqual([
      "MPI-78",
    ]);
    expect(
      (await attentionItems(buyer)).find((i) => i.key === "TRADE_DOCUMENTS_EXPIRING")?.count,
    ).toBe(1);
    await advanceShipment(buyer, shipmentId);
    expect((await getShipment(buyer, shipmentId)).status).toBe("CLEARED");
  });

  it("removes a document with a reason; it then no longer counts", async () => {
    const doc = await addProductDocument(buyer, {
      documentTypeId: types.REG,
      productId: milk,
      expiresOn: addDays(today, 5),
    });
    await expectAppError(archiveTradeDocument(buyer, doc.id, { reason: "" }), "VALIDATION_FAILED");
    await archiveTradeDocument(buyer, doc.id, { reason: "Entered twice" });
    await expectRule(
      renewTradeDocument(buyer, doc.id, { expiresOn: addDays(today, 50) }),
      "DOCUMENT_ARCHIVED",
    );
    expect((await listTradeDocuments(buyer, { productId: milk })).map((d) => d.number)).toEqual([
      "SFDA-123",
    ]);
  });

  it("is changed by those managing trade; others see or nothing", async () => {
    const keeper = await addMember(ctx, "warehouse", { scopeType: "WAREHOUSE", warehouseId });
    expect((await listTradeDocuments(keeper.ctx)).length).toBeGreaterThan(0);
    await expectAppError(
      addProductDocument(keeper.ctx, {
        documentTypeId: types.REG,
        productId: milk,
        expiresOn: today,
      }),
      "FORBIDDEN",
    );
    await expectAppError(
      addShipmentDocument(keeper.ctx, shipmentId, { documentTypeId: types.INV }),
      "FORBIDDEN",
    );
    await expectAppError(
      createDocumentType(keeper.ctx, { code: "X", name: "x", scope: "SHIPMENT" }),
      "FORBIDDEN",
    );
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(listTradeDocuments(cashier.ctx), "FORBIDDEN");
    const { ctx: other } = await createTenant("trade-docs-other");
    await expectAppError(
      addShipmentDocument(other, shipmentId, { documentTypeId: types.INV }),
      "NOT_FOUND",
    );
    await expectAppError(createRequirement(other, { documentTypeId: types.INV }), "NOT_FOUND");
  });
});
