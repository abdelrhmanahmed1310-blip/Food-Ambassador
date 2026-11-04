import { beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { createProduct, getProduct, listUnits, updateProduct } from "@/modules/catalog/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { postReceipt } from "@/modules/procurement/receipts";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addContainer,
  advanceShipment,
  cancelShipment,
  createShipment,
  getShipment,
  linkOrder,
  linkReceipt,
  listShipments,
  removeContainer,
  unlinkOrder,
  updateShipment,
} from "./shipments";

/** Import shipments (ADR-113). */

let ctx: TenantContext;
let buyer: TenantContext;
let today: string;
let warehouseId: string;
let otherWarehouse: string;
let supplierId: string;
let milk: string;
let units: Record<string, string>;

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

async function approvedOrder(warehouse = warehouseId, supplier = supplierId) {
  const { id } = await createOrder(buyer, { supplierId: supplier, warehouseId: warehouse });
  await addOrderLine(buyer, id, {
    productId: milk,
    uomId: units.kg,
    quantity: "1000",
    unitPrice: "12",
  });
  await submitOrder(buyer, id);
  return id;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("imports"));
  buyer = (await addMember(ctx, "procurement")).ctx;
  today = businessDate(ctx.timeZone);
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (
    await createBranch(ctx, { code: "JED", name: "Jeddah", type: "CENTRAL_KITCHEN" })
  ).id;
  warehouseId = (await createWarehouse(ctx, { branchId, code: "DC", name: "DC", type: "MAIN" })).id;
  const other = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" })).id;
  otherWarehouse = (
    await createWarehouse(ctx, { branchId: other, code: "RUH-W", name: "W", type: "MAIN" })
  ).id;
  milk = (
    await createProduct(ctx, {
      sku: "MILKPOWDER",
      nameEn: "Milk powder",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  supplierId = (await createSupplier(ctx, { code: "NZDAIRY", name: "NZ Dairy" })).id;
}, 60_000);

describe("products carry trade data (ADR-113)", () => {
  it("keeps the HS code as digits and the origin as an ISO country", async () => {
    const p = await getProduct(ctx, milk);
    const base = {
      sku: p.sku,
      nameEn: p.nameEn,
      type: p.type,
      baseUomId: p.baseUomId,
      lotTracking: p.lotTracking,
      storageRequirement: p.storageRequirement,
    };
    await updateProduct(ctx, milk, { ...base, hsCode: "0402.21 10", originCountry: "nz" });
    expect(await getProduct(ctx, milk)).toMatchObject({ hsCode: "04022110", originCountry: "NZ" });
    await expectAppError(
      updateProduct(ctx, milk, { ...base, hsCode: "0402" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      updateProduct(ctx, milk, { ...base, originCountry: "XX" }),
      "VALIDATION_FAILED",
    );
    // Left out: unchanged.
    await updateProduct(ctx, milk, base);
    expect((await getProduct(ctx, milk)).hsCode).toBe("04022110");
  });
});

describe("import shipments (ADR-113)", () => {
  it("plans a shipment with its orders and containers, then tracks it to receipt", async () => {
    const order = await approvedOrder();
    const s = await createShipment(buyer, {
      supplierId,
      warehouseId,
      mode: "SEA",
      incoterm: "CIF",
      originCountry: "NZ",
      portOfLoading: "Auckland",
      portOfDischarge: "Jeddah Islamic Port",
      carrier: "Maersk",
      transportDocument: "MAEU123456789",
      etd: addDays(today, -30),
      eta: addDays(today, -2),
    });
    expect(s.number).toMatch(/^IMP-/);
    await expectAppError(
      createShipment(buyer, {
        supplierId,
        warehouseId,
        mode: "SEA",
        etd: today,
        eta: addDays(today, -1),
      }),
      "VALIDATION_FAILED",
    );
    // Departing needs the orders on it.
    await expectRule(advanceShipment(buyer, s.id), "SHIPMENT_HAS_NO_ORDERS");
    await linkOrder(buyer, s.id, { purchaseOrderId: order });
    await expectAppError(linkOrder(buyer, s.id, { purchaseOrderId: order }), "CONFLICT");
    await expectRule(
      linkOrder(buyer, s.id, { purchaseOrderId: await approvedOrder(otherWarehouse) }),
      "ORDER_OTHER_SUPPLIER_OR_WAREHOUSE",
    );
    await addContainer(buyer, s.id, {
      number: "csqu 305438-3",
      type: "REEFER_40",
      sealNumber: "S-1",
      temperatureC: "-18",
    });
    await expectAppError(
      addContainer(buyer, s.id, { number: "CSQU3054384", type: "DRY_20" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      addContainer(buyer, s.id, { number: "MSKU1234565", type: "DRY_20", temperatureC: "4" }),
      "VALIDATION_FAILED",
    );
    await addContainer(buyer, s.id, { number: "MSKU1234565", type: "DRY_20" });
    await expectAppError(
      addContainer(buyer, s.id, { number: "MSKU1234565", type: "DRY_20" }),
      "CONFLICT",
    );
    const dry = (await getShipment(buyer, s.id)).containers.find(
      (c) => c.number === "MSKU1234565",
    )!;
    await removeContainer(buyer, s.id, dry.id);

    // Departed 28 days ago: two days past its ETA it is late.
    await advanceShipment(buyer, s.id, { date: addDays(today, -28) });
    let view = await getShipment(buyer, s.id);
    expect([
      view.status,
      view.departedOn,
      view.daysLate,
      view.containers.map((c) => c.number),
    ]).toEqual(["IN_TRANSIT", addDays(today, -28), 2, ["CSQU3054383"]]);
    expect(
      (await listShipments(buyer, { status: "OPEN" })).map((x) => [x.number, x.daysLate]),
    ).toEqual([[s.number, 2]]);
    const late = (await attentionItems(buyer)).find((i) => i.key === "IMPORT_SHIPMENTS_LATE");
    expect([late?.count, late?.links?.[0].label]).toEqual([1, s.number]);
    await expectRule(
      advanceShipment(buyer, s.id, { date: addDays(today, -29) }),
      "DATE_BEFORE_PREVIOUS_STEP",
    );
    await expectRule(advanceShipment(buyer, s.id, { date: addDays(today, 1) }), "DATE_IN_FUTURE");
    await updateShipment(buyer, s.id, {
      mode: "SEA",
      vesselOrFlight: "Maersk Kensington",
      eta: addDays(today, -1),
    });

    // Receipts link only after arrival.
    const po = await getOrder(buyer, order);
    const receipt = await postReceipt(buyer, order, {
      lines: [{ purchaseOrderLineId: po.lines[0].id, receivedQuantity: "1000", unitPrice: "12" }],
    });
    await expectRule(linkReceipt(buyer, s.id, { receiptId: receipt.id }), "SHIPMENT_NOT_ARRIVED");
    await advanceShipment(buyer, s.id);
    view = await getShipment(buyer, s.id);
    expect([view.status, view.daysLate, view.linkableReceipts.map((r) => r.number)]).toEqual([
      "ARRIVED",
      null,
      [receipt.number],
    ]);
    await linkReceipt(buyer, s.id, { receiptId: receipt.id });
    await expectRule(unlinkOrder(buyer, s.id, order), "ORDER_HAS_SHIPMENT_RECEIPTS");
    await advanceShipment(buyer, s.id);
    await expectRule(updateShipment(buyer, s.id, { mode: "AIR" }), "SHIPMENT_NOT_EDITABLE");
    await expectRule(cancelShipment(buyer, s.id, { reason: "x" }), "SHIPMENT_NOT_CANCELLABLE");
    await advanceShipment(buyer, s.id);
    view = await getShipment(buyer, s.id);
    expect([
      view.status,
      view.receipts.map((r) => r.number),
      view.orders[0].receivedShare?.toFixed(),
    ]).toEqual(["CLOSED", [receipt.number], "1"]);
    await expectRule(advanceShipment(buyer, s.id), "SHIPMENT_NOT_ADVANCEABLE");
    // The database keeps dates in order.
    await expect(
      getDb().importShipment.update({
        where: { id: s.id },
        data: { clearedOn: new Date(`${addDays(today, -40)}T00:00:00Z`) },
      }),
    ).rejects.toThrow();
  });

  it("cancels before arrival with a reason, freeing its orders", async () => {
    const s = await createShipment(buyer, { supplierId, warehouseId, mode: "AIR" });
    const order = await approvedOrder();
    await linkOrder(buyer, s.id, { purchaseOrderId: order });
    await expectAppError(cancelShipment(buyer, s.id, { reason: "" }), "VALIDATION_FAILED");
    await cancelShipment(buyer, s.id, { reason: "Supplier delayed production" });
    expect((await getShipment(buyer, s.id)).status).toBe("CANCELLED");
    expect((await listShipments(buyer, { status: "OPEN" })).some((x) => x.id === s.id)).toBe(false);
  });

  it("is seen at its warehouse and managed by purchasing", async () => {
    const s = await createShipment(buyer, { supplierId, warehouseId, mode: "ROAD" });
    const keeper = await addMember(ctx, "warehouse", { scopeType: "WAREHOUSE", warehouseId });
    expect((await getShipment(keeper.ctx, s.id)).canManage).toBe(false);
    await expectAppError(
      addContainer(keeper.ctx, s.id, { number: "CSQU3054383", type: "DRY_20" }),
      "FORBIDDEN",
    );
    const elsewhere = await addMember(ctx, "warehouse", {
      scopeType: "WAREHOUSE",
      warehouseId: otherWarehouse,
    });
    await expectAppError(getShipment(elsewhere.ctx, s.id), "NOT_FOUND");
    expect(await listShipments(elsewhere.ctx)).toEqual([]);
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(listShipments(cashier.ctx), "FORBIDDEN");
    const { ctx: other } = await createTenant("imports-other");
    await expectAppError(getShipment(other, s.id), "NOT_FOUND");
    await expectAppError(
      createShipment(other, { supplierId, warehouseId, mode: "SEA" }),
      "NOT_FOUND",
    );
  });
});
