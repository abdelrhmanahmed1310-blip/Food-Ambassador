import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { reconcileBalances } from "@/modules/inventory/queries";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { cancelShipment, dispatchShipment, getShipment } from "@/modules/inventory/shipments";
import { createSupplier } from "@/modules/procurement/suppliers";
import {
  addRequisitionLine,
  createRequisition,
  fulfilRequisitionFromStock,
  getRequisition,
  orderRequisition,
  submitRequisition,
} from "@/modules/procurement/requisitions";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";

let ctx: TenantContext;
let units: Record<string, string>;
let ck: string;
let branchWh: string;
let rice: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("fulfilment"));
  const today = businessDate(ctx.timeZone);
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const hq = (
    await createBranch(ctx, { code: "CK", name: "Central kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  const shop = (await createBranch(ctx, { code: "ZAM", name: "Zamalek", type: "RESTAURANT" })).id;
  ck = (
    await createWarehouse(ctx, { branchId: hq, code: "CK", name: "Central kitchen", type: "MAIN" })
  ).id;
  branchWh = (
    await createWarehouse(ctx, {
      branchId: shop,
      code: "ZK",
      name: "Zamalek kitchen",
      type: "KITCHEN_STORE",
    })
  ).id;
  rice = (
    await createProduct(ctx, {
      sku: "RICE",
      nameEn: "Rice",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
      lotTracking: "LOT_AND_EXPIRY",
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: ck,
    productId: rice,
    lotCode: "R-OLD",
    expiresOn: addDays(today, 5),
    quantity: "3",
    uomId: units.kg,
    unitCost: "10",
  });
  await postOpeningBalance(ctx, {
    warehouseId: ck,
    productId: rice,
    lotCode: "R-NEW",
    expiresOn: addDays(today, 30),
    quantity: "10",
    uomId: units.kg,
    unitCost: "10",
  });
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
  await getDb().$disconnect();
});

async function request(quantity: string) {
  const r = await createRequisition(ctx, { warehouseId: branchWh });
  await addRequisitionLine(ctx, r.id, { productId: rice, quantity, uomId: units.kg });
  await submitRequisition(ctx, r.id);
  return { id: r.id, lineId: (await getRequisition(ctx, r.id)).lines[0].id };
}

describe("fulfilling branch requests from the central kitchen", () => {
  it("picks FEFO into a draft shipment and marks the line as met", async () => {
    const req = await request("5");
    const s = await fulfilRequisitionFromStock(ctx, req.id, {
      fromWarehouseId: ck,
      lineIds: [req.lineId],
    });
    expect(s.number).toMatch(/^SHP-/);
    const shipment = await getShipment(ctx, s.shipmentId);
    expect(shipment.lines.map((l) => [l.lot?.lotCode, l.quantityBase.toFixed()])).toEqual([
      ["R-OLD", "3"],
      ["R-NEW", "2"],
    ]);
    const after = await getRequisition(ctx, req.id);
    expect(after.status).toBe("ORDERED");
    expect(after.lines[0].shipmentId).toBe(s.shipmentId);
    // It cannot also be ordered from a supplier, or fulfilled twice.
    const supplierId = (await createSupplier(ctx, { code: "MILL", name: "Mill" })).id;
    await expectAppError(
      orderRequisition(ctx, req.id, {
        supplierId,
        lines: [{ lineId: req.lineId, include: "on", unitPrice: "1" }],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      fulfilRequisitionFromStock(ctx, req.id, { fromWarehouseId: ck, lineIds: [req.lineId] }),
      "BUSINESS_RULE_VIOLATION",
    );

    // Cancelling the shipment opens the request again.
    await cancelShipment(ctx, s.shipmentId, { reason: "Truck broke down" });
    const reopened = await getRequisition(ctx, req.id);
    expect([reopened.status, reopened.lines[0].shipmentId]).toEqual(["SUBMITTED", null]);
    const again = await fulfilRequisitionFromStock(ctx, req.id, {
      fromWarehouseId: ck,
      lineIds: [req.lineId],
    });
    await dispatchShipment(ctx, again.shipmentId);
    expect((await getShipment(ctx, again.shipmentId)).status).toBe("IN_TRANSIT");
  });

  it("refuses when the kitchen is short, from the same place, or without rights", async () => {
    const req = await request("50");
    await expectAppError(
      fulfilRequisitionFromStock(ctx, req.id, { fromWarehouseId: ck, lineIds: [req.lineId] }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await getRequisition(ctx, req.id)).status).toBe("SUBMITTED");
    await expectAppError(
      fulfilRequisitionFromStock(ctx, req.id, { fromWarehouseId: branchWh, lineIds: [req.lineId] }),
      "BUSINESS_RULE_VIOLATION",
    );
    const analyst = (await addMember(ctx, "analyst")).ctx;
    await expectAppError(
      fulfilRequisitionFromStock(analyst, req.id, { fromWarehouseId: ck, lineIds: [req.lineId] }),
      "FORBIDDEN",
    );
    const other = await createTenant("fulfilment-other");
    await expectAppError(
      fulfilRequisitionFromStock(other.ctx, req.id, { fromWarehouseId: ck, lineIds: [req.lineId] }),
      "NOT_FOUND",
    );
  });
});
