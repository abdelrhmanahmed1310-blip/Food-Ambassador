import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance, postTransfer, postWriteOff } from "@/modules/inventory/operations";
import { reconcileBalances } from "@/modules/inventory/queries";
import {
  addShipmentLine,
  createShipment,
  dispatchShipment,
  getShipment,
  receiveShipment,
} from "@/modules/inventory/shipments";
import { reconcileValuations } from "@/modules/inventory/valuation-queries";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { postReceipt } from "@/modules/procurement/receipts";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  activateRecall,
  addRecallLots,
  cancelRecall,
  closeRecall,
  createRecall,
  getRecall,
  listRecalls,
  removeRecallLot,
} from "./recalls";
import { lotsFromSupplier, searchLots, traceLot } from "./trace";

let ctx: TenantContext;
let units: Record<string, string>;
let main: string;
let kitchen: string;
let flour: string;
let supplierId: string;
let received: string; // lot from the supplier
let opening: string; // lot from an opening balance
let shipmentId: string;

async function stock(lotId: string, warehouseId: string, status: string) {
  const rows = await getDb().stockBalance.findMany({
    where: { organizationId: ctx.organizationId, lotId, warehouseId, stockStatus: status as never },
  });
  return rows.reduce((a, r) => a.plus(r.onHandQuantity.toString()), new Decimal(0)).toFixed();
}

beforeAll(async () => {
  ({ ctx } = await createTenant("trace"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "HQ", name: "HQ", type: "RESTAURANT" })).id;
  main = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  flour = (
    await createProduct(ctx, {
      sku: "FLOUR",
      nameEn: "Flour",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
      lotTracking: "LOT",
    })
  ).id;
  supplierId = (
    await createSupplier(ctx, { code: "MILLS", name: "Delta Mills", phone: "+20 2 0000 0000" })
  ).id;
  // Older stock from before the system, then a delivery from the supplier.
  await postOpeningBalance(ctx, {
    warehouseId: main,
    productId: flour,
    lotCode: "F-OLD",
    quantity: "20",
    uomId: units.kg,
    unitCost: "9",
  });
  const { id: orderId } = await createOrder(ctx, { supplierId, warehouseId: main });
  await addOrderLine(ctx, orderId, {
    productId: flour,
    quantity: "100",
    uomId: units.kg,
    unitPrice: "10",
  });
  await submitOrder(ctx, orderId);
  const order = await getOrder(ctx, orderId);
  await postReceipt(ctx, orderId, {
    deliveryNoteRef: "DN-77",
    lines: [
      {
        purchaseOrderLineId: order.lines[0].id,
        receivedQuantity: "100",
        unitPrice: "10",
        lotCode: "F-0001",
      },
    ],
  });
  const lots = await searchLots(ctx, "f-");
  received = lots.find((l) => l.lotCode === "F-0001")!.id;
  opening = lots.find((l) => l.lotCode === "F-OLD")!.id;
  // 30 kg to the kitchen, 5 kg spoiled there, 10 kg on a truck to the kitchen.
  await postTransfer(ctx, {
    warehouseId: main,
    productId: flour,
    lotId: received,
    toWarehouseId: kitchen,
    quantity: "30",
    uomId: units.kg,
  });
  await postWriteOff(ctx, {
    warehouseId: kitchen,
    productId: flour,
    lotId: received,
    stockStatus: "AVAILABLE",
    quantity: "5",
    uomId: units.kg,
    reasonCode: "SPOILED",
  });
  shipmentId = (await createShipment(ctx, { fromWarehouseId: main, toWarehouseId: kitchen })).id;
  const balance = await getDb().stockBalance.findFirstOrThrow({
    where: {
      organizationId: ctx.organizationId,
      lotId: received,
      warehouseId: main,
      stockStatus: "AVAILABLE",
    },
  });
  await addShipmentLine(ctx, shipmentId, {
    balanceId: balance.id,
    quantity: "10",
    uomId: units.kg,
  });
  await dispatchShipment(ctx, shipmentId);
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
  expect(await reconcileValuations(ctx)).toEqual([]);
  await getDb().$disconnect();
});

describe("lot traceability", () => {
  it("traces a lot back to its supplier and forward to every place it went", async () => {
    const t = await traceLot(ctx, received);
    expect(t.receipts).toHaveLength(1);
    expect(t.receipts[0].receipt).toMatchObject({
      deliveryNoteRef: "DN-77",
      supplier: { code: "MILLS" },
    });
    expect(t.origins.map((o) => o.movementType)).toEqual(["RECEIPT"]);
    expect(t.exits.map((o) => o.movementType)).toEqual(["WRITE_OFF"]);
    expect([t.received.toFixed(), t.exited.toFixed(), t.onHand.toFixed()]).toEqual([
      "100",
      "5",
      "95",
    ]);
    const places = t.stock.map((s) => [
      s.warehouse.code,
      s.stockStatus,
      s.onHandQuantity.toFixed(),
    ]);
    expect(places).toEqual(
      expect.arrayContaining([
        ["MAIN", "AVAILABLE", "60"],
        ["MAIN", "IN_TRANSIT", "10"],
        ["KIT", "AVAILABLE", "25"],
      ]),
    );
    expect(t.shipments[0].shipment.status).toBe("IN_TRANSIT");
    expect(t.gaps).toEqual([]);
  });

  it("reports a lot without a known origin as a gap", async () => {
    const t = await traceLot(ctx, opening);
    expect(t.receipts).toEqual([]);
    expect(t.gaps.map((g) => [g.kind, g.quantity])).toEqual([["ORIGIN_WITHOUT_SUPPLIER", "20"]]);
  });

  it("finds lots by code or product and by supplier", async () => {
    expect((await searchLots(ctx, "FLOUR")).length).toBe(2);
    expect(await searchLots(ctx, " ")).toEqual([]);
    expect(await lotsFromSupplier(ctx, supplierId)).toEqual([received]);
  });
});

describe("recalls", () => {
  it("simulates, goes live everywhere, holds goods on the way and disposes", async () => {
    const recall = await createRecall(ctx, {
      title: "Delta Mills flour",
      reason: "Supplier notice: foreign matter",
    });
    expect(recall.number).toMatch(/^RCL-\d{4}-\d{6}$/);
    await addRecallLots(ctx, recall.id, { lotIds: await lotsFromSupplier(ctx, supplierId) });
    await addRecallLots(ctx, recall.id, { lotIds: [opening] });
    await removeRecallLot(ctx, recall.id, opening);
    // Draft = simulation: nothing changes.
    let r = await getRecall(ctx, recall.id);
    expect(r.status).toBe("DRAFT");
    expect(r.lotSummaries[0].onHand.toFixed()).toBe("95");
    expect(r.suppliers.map((s) => s.code)).toEqual(["MILLS"]);
    expect(r.inTransit.map((s) => s.onHandQuantity.toFixed())).toEqual(["10"]);
    expect(await stock(received, main, "AVAILABLE")).toBe("60");

    await activateRecall(ctx, recall.id);
    r = await getRecall(ctx, recall.id);
    expect(r.status).toBe("ACTIVE");
    expect(r.lots[0].lot.recallHold).toBe(true);
    expect(r.stock.map((s) => s.quantity.toFixed()).sort()).toEqual(["10", "25", "60"]);
    expect(r.documents.map((d) => d.kind)).toEqual(["HOLD", "HOLD"]);
    expect(await stock(received, main, "ON_HOLD")).toBe("60");
    expect(await stock(received, kitchen, "ON_HOLD")).toBe("25");
    expect(await stock(received, main, "AVAILABLE")).toBe("0");
    // Recall-held stock cannot be moved.
    await expectAppError(
      postTransfer(ctx, {
        warehouseId: kitchen,
        productId: flour,
        lotId: received,
        toWarehouseId: main,
        quantity: "1",
        uomId: units.kg,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      addRecallLots(ctx, recall.id, { lotIds: [opening] }),
      "BUSINESS_RULE_VIOLATION",
    );

    // The truck arrives: the recalled lot goes straight on hold.
    const shipment = await getShipment(ctx, shipmentId);
    await receiveShipment(ctx, shipmentId, {
      lines: [{ lineId: shipment.lines[0].id, receivedQuantity: "10" }],
    });
    expect(await stock(received, kitchen, "ON_HOLD")).toBe("35");
    expect(await stock(received, kitchen, "AVAILABLE")).toBe("0");

    await expectAppError(
      closeRecall(ctx, recall.id, { outcome: "DISPOSED", note: "" }),
      "VALIDATION_FAILED",
    );
    await closeRecall(ctx, recall.id, {
      outcome: "DISPOSED",
      note: "Destroyed by the supplier's agent",
    });
    r = await getRecall(ctx, recall.id);
    expect(r).toMatchObject({ status: "CLOSED", outcome: "DISPOSED" });
    expect(r.documents.filter((d) => d.kind === "DISPOSAL")).toHaveLength(2);
    expect(r.lotSummaries[0].onHand.toFixed()).toBe("0");
    expect(r.lotSummaries[0].writtenOff.toFixed()).toBe("100");
    expect(r.lots[0].lot.recallHold).toBe(true);
  });

  it("releases a recall's hold but leaves the stock on hold for a person to free", async () => {
    const recall = await createRecall(ctx, { title: "Old flour check", reason: "Precaution" });
    await addRecallLots(ctx, recall.id, { lotIds: [opening] });
    await activateRecall(ctx, recall.id);
    expect(await stock(opening, main, "ON_HOLD")).toBe("20");
    await closeRecall(ctx, recall.id, { outcome: "RELEASED", note: "Lab test passed" });
    const lot = await getDb().inventoryLot.findUniqueOrThrow({ where: { id: opening } });
    expect(lot.recallHold).toBe(false);
    expect(await stock(opening, main, "ON_HOLD")).toBe("20");
  });

  it("refuses wrong states, users without permission and other tenants", async () => {
    const draft = await createRecall(ctx, { title: "Empty", reason: "Test" });
    await expectAppError(activateRecall(ctx, draft.id), "BUSINESS_RULE_VIOLATION");
    await expectAppError(
      closeRecall(ctx, draft.id, { outcome: "RELEASED", note: "x" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await cancelRecall(ctx, draft.id, { note: "Opened by mistake" });
    expect((await listRecalls(ctx)).find((r) => r.id === draft.id)).toMatchObject({
      status: "CLOSED",
      outcome: null,
    });

    const storekeeper = (await addMember(ctx, "warehouse")).ctx;
    expect((await traceLot(storekeeper, received)).receipts).toHaveLength(1);
    await expectAppError(createRecall(storekeeper, { title: "x", reason: "y" }), "FORBIDDEN");
    const finance = (await addMember(ctx, "finance")).ctx;
    await expectAppError(traceLot(finance, received), "FORBIDDEN");
    const quality = (await addMember(ctx, "food_safety")).ctx;
    expect((await createRecall(quality, { title: "QA", reason: "Check" })).number).toMatch(/^RCL-/);

    const other = await createTenant("trace-other");
    await expectAppError(traceLot(other.ctx, received), "NOT_FOUND");
    await expectAppError(getRecall(other.ctx, draft.id), "NOT_FOUND");
    const theirs = await createRecall(other.ctx, { title: "Theirs", reason: "x" });
    await expectAppError(addRecallLots(other.ctx, theirs.id, { lotIds: [received] }), "NOT_FOUND");
    expect(await searchLots(other.ctx, "F-")).toEqual([]);
  });
});
