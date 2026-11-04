import { beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import {
  addSalesOrderLine,
  confirmSalesOrder,
  createCustomer,
  createSalesOrder,
  deliverSalesOrder,
  getSalesOrder,
} from "@/modules/b2b/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addShipmentLine, createShipment, dispatchShipment } from "@/modules/inventory/shipments";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addStop,
  cancelTrip,
  completeTrip,
  createTrip,
  createVehicle,
  deliverStop,
  failStop,
  getTrip,
  listTrips,
  recordReading,
  removeStop,
  startTrip,
  tripFormOptions,
} from "./trips";

/** Own fleet: trips, proof of delivery and cold chain (ADR-116). */

let ctx: TenantContext;
let today: string;
let dc: string;
let shop: string;
let reefer: string;
let driver: { ctx: TenantContext; userId: string };
let deliveries: string[];
let transfer: string;

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

beforeAll(async () => {
  ({ ctx } = await createTenant("fleet"));
  today = businessDate(ctx.timeZone);
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (
    await createBranch(ctx, { code: "CK", name: "Kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  dc = (await createWarehouse(ctx, { branchId, code: "DC", name: "DC", type: "MAIN" })).id;
  const shopBranch = (await createBranch(ctx, { code: "SHOP", name: "Shop", type: "RESTAURANT" }))
    .id;
  shop = (
    await createWarehouse(ctx, { branchId: shopBranch, code: "SHOP-W", name: "Shop", type: "MAIN" })
  ).id;
  const yogurt = (
    await createProduct(ctx, {
      sku: "YOG",
      nameEn: "Yogurt",
      type: "FINISHED_GOOD",
      baseUomId: units.kg,
      storageRequirement: "CHILLED",
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: dc,
    productId: yogurt,
    quantity: "500",
    uomId: units.kg,
    unitCost: "6",
  });
  deliveries = [];
  for (const code of ["CAFE", "HOTEL"]) {
    const customerId = (
      await createCustomer(ctx, { code, name: code, city: "Riyadh", street: "King Fahd Rd" })
    ).id;
    const order = await createSalesOrder(ctx, { customerId, warehouseId: dc });
    await addSalesOrderLine(ctx, order.id, {
      productId: yogurt,
      quantity: "20",
      uomId: units.kg,
      unitPrice: "10",
    });
    await confirmSalesOrder(ctx, order.id);
    const lineId = (await getSalesOrder(ctx, order.id)).lines[0].id;
    deliveries.push(
      (await deliverSalesOrder(ctx, order.id, { lines: [{ lineId, quantity: "20" }] })).id,
    );
  }
  const balance = await getDb().stockBalance.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, warehouseId: dc, productId: yogurt },
  });
  transfer = (await createShipment(ctx, { fromWarehouseId: dc, toWarehouseId: shop })).id;
  await addShipmentLine(ctx, transfer, { balanceId: balance.id, quantity: "30", uomId: units.kg });
  await dispatchShipment(ctx, transfer);
  const d = await addMember(ctx, "driver", { scopeType: "WAREHOUSE", warehouseId: dc });
  driver = { ctx: d.ctx, userId: d.ctx.userId };
}, 90_000);

describe("vehicles (ADR-116)", () => {
  it("keeps a temperature range for refrigerated vehicles only", async () => {
    reefer = (
      await createVehicle(ctx, {
        code: "R1",
        plateNumber: "ABC 1234",
        type: "TRUCK",
        warehouseId: dc,
        refrigerated: "on",
        minTemperatureC: "0",
        maxTemperatureC: "5",
      })
    ).id;
    await expectAppError(
      createVehicle(ctx, {
        code: "R2",
        plateNumber: "X",
        type: "VAN",
        warehouseId: dc,
        refrigerated: "on",
      }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createVehicle(ctx, {
        code: "R3",
        plateNumber: "X",
        type: "VAN",
        warehouseId: dc,
        refrigerated: "on",
        minTemperatureC: "5",
        maxTemperatureC: "0",
      }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createVehicle(ctx, { code: "r1", plateNumber: "X", type: "VAN", warehouseId: dc }),
      "CONFLICT",
    );
    const opts = await tripFormOptions(ctx);
    expect(opts.drivers[dc].map((u) => u.id)).toContain(driver.userId);
    expect(opts.drivers[shop].map((u) => u.id)).not.toContain(driver.userId);
  });
});

describe("trips (ADR-116)", () => {
  it("plans a trip with delivery and transfer stops, then drives it with proof of delivery", async () => {
    await expectRule(
      createTrip(ctx, {
        warehouseId: shop,
        vehicleId: reefer,
        driverUserId: ctx.userId,
        plannedOn: today,
      }),
      "VEHICLE_OTHER_WAREHOUSE",
    );
    const keeper = await addMember(ctx, "cashier");
    await expectRule(
      createTrip(ctx, {
        warehouseId: dc,
        vehicleId: reefer,
        driverUserId: keeper.ctx.userId,
        plannedOn: today,
      }),
      "DRIVER_NOT_ALLOWED",
    );
    const trip = await createTrip(ctx, {
      warehouseId: dc,
      vehicleId: reefer,
      driverUserId: driver.userId,
      plannedOn: today,
    });
    expect(trip.number).toMatch(/^TRP-/);
    let view = await getTrip(ctx, trip.id);
    expect([view.consignments.deliveries.length, view.consignments.transfers.length]).toEqual([
      2, 1,
    ]);
    await expectRule(startTrip(driver.ctx, trip.id), "TRIP_HAS_NO_STOPS");
    for (const id of deliveries)
      await addStop(ctx, trip.id, { kind: "CUSTOMER_DELIVERY", consignmentId: id });
    await addStop(ctx, trip.id, { kind: "TRANSFER", consignmentId: transfer });
    // Not twice, and not a delivery offered as a transfer.
    await expectAppError(
      addStop(ctx, trip.id, { kind: "CUSTOMER_DELIVERY", consignmentId: deliveries[0] }),
      "CONFLICT",
    );
    await expectAppError(
      addStop(ctx, trip.id, { kind: "TRANSFER", consignmentId: deliveries[0] }),
      "NOT_FOUND",
    );
    // The driver drives; planning is not theirs.
    await expectAppError(
      addStop(driver.ctx, trip.id, { kind: "TRANSFER", consignmentId: transfer }),
      "FORBIDDEN",
    );

    await startTrip(driver.ctx, trip.id, { startOdometerKm: "12000" });
    expect((await recordReading(driver.ctx, trip.id, { temperatureC: "3.5" })).excursion).toBe(
      false,
    );
    expect(
      (await recordReading(driver.ctx, trip.id, { temperatureC: "7.2", note: "Door left open" }))
        .excursion,
    ).toBe(true);
    view = await getTrip(driver.ctx, trip.id);
    const [cafe, hotel, shopStop] = view.stops;
    expect([cafe.customerDelivery?.order.customer.code, shopStop.stockShipment?.to.code]).toEqual([
      "CAFE",
      "SHOP-W",
    ]);

    await expectRule(
      deliverStop(driver.ctx, trip.id, cafe.id, { recipientName: "Omar" }),
      "HANDOVER_TEMPERATURE_REQUIRED",
    );
    await expectAppError(
      deliverStop(driver.ctx, trip.id, cafe.id, {
        recipientName: "Omar",
        handoverTemperatureC: "4",
        signature: "<script>alert(1)</script>",
      }),
      "VALIDATION_FAILED",
    );
    await deliverStop(driver.ctx, trip.id, cafe.id, {
      recipientName: "Omar",
      handoverTemperatureC: "4.1",
      signature: "M 10 20 L 40.6 60 L 80 30",
    });
    await expectRule(
      deliverStop(driver.ctx, trip.id, cafe.id, { recipientName: "x", handoverTemperatureC: "4" }),
      "STOP_ALREADY_RECORDED",
    );
    await expectRule(completeTrip(driver.ctx, trip.id), "TRIP_STOPS_OPEN");
    await failStop(driver.ctx, trip.id, hotel.id, { reason: "Receiving closed" });
    await deliverStop(driver.ctx, trip.id, shopStop.id, {
      recipientName: "Shop manager",
      handoverTemperatureC: "4.5",
    });
    await expectRule(
      completeTrip(driver.ctx, trip.id, { endOdometerKm: "11000" }),
      "ODOMETER_BACKWARDS",
    );
    await completeTrip(driver.ctx, trip.id, { endOdometerKm: "12086" });

    view = await getTrip(ctx, trip.id);
    expect([view.status, view.distanceKm, view.excursions, view.readings.length]).toEqual([
      "COMPLETED",
      86,
      1,
      4,
    ]);
    expect(view.stops.map((s) => [s.status, s.recipientName, s.signatureSvg])).toEqual([
      ["DELIVERED", "Omar", "M 10 20 L 41 60 L 80 30"],
      ["FAILED", null, null],
      ["DELIVERED", "Shop manager", null],
    ]);
    // A recorded proof of delivery never changes.
    await expect(
      getDb().tripStop.update({ where: { id: cafe.id }, data: { recipientName: "Someone else" } }),
    ).rejects.toThrow();
    expect(
      (await attentionItems(ctx)).find((i) => i.key === "COLD_CHAIN_EXCURSIONS")?.links?.[0].label,
    ).toBe(trip.number);
    expect(
      (await listTrips(driver.ctx, { mine: "1" })).map((t) => [
        t.number,
        t.delivered,
        t.failed,
        t.excursions,
      ]),
    ).toEqual([[trip.number, 2, 1, 1]]);
  });

  it("puts a failed delivery on a new trip, and frees stops when a trip is cancelled", async () => {
    const again = await createTrip(ctx, {
      warehouseId: dc,
      vehicleId: reefer,
      driverUserId: driver.userId,
      plannedOn: today,
    });
    // The hotel delivery failed: it can go again. The café one was delivered: it cannot.
    expect((await getTrip(ctx, again.id)).consignments.deliveries.map((d) => d.id)).toEqual([
      deliveries[1],
    ]);
    await addStop(ctx, again.id, { kind: "CUSTOMER_DELIVERY", consignmentId: deliveries[1] });
    const stop = (await getTrip(ctx, again.id)).stops[0];
    await removeStop(ctx, again.id, stop.id);
    await addStop(ctx, again.id, { kind: "CUSTOMER_DELIVERY", consignmentId: deliveries[1] });
    await expectAppError(cancelTrip(ctx, again.id, { reason: "" }), "VALIDATION_FAILED");
    await cancelTrip(ctx, again.id, { reason: "Vehicle in service" });
    const third = await createTrip(ctx, {
      warehouseId: dc,
      vehicleId: reefer,
      driverUserId: driver.userId,
      plannedOn: today,
    });
    await addStop(ctx, third.id, { kind: "CUSTOMER_DELIVERY", consignmentId: deliveries[1] });
  });

  it("is driven by its own driver; others see or nothing", async () => {
    const trip = await createTrip(ctx, {
      warehouseId: dc,
      vehicleId: reefer,
      driverUserId: ctx.userId,
      plannedOn: today,
    });
    await expectAppError(startTrip(driver.ctx, trip.id), "FORBIDDEN");
    const elsewhere = await addMember(ctx, "warehouse", {
      scopeType: "WAREHOUSE",
      warehouseId: shop,
    });
    await expectAppError(getTrip(elsewhere.ctx, trip.id), "NOT_FOUND");
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(listTrips(cashier.ctx), "FORBIDDEN");
    const { ctx: other } = await createTenant("fleet-other");
    await expectAppError(getTrip(other, trip.id), "NOT_FOUND");
    await expectAppError(
      createTrip(other, {
        warehouseId: dc,
        vehicleId: reefer,
        driverUserId: driver.userId,
        plannedOn: today,
      }),
      "NOT_FOUND",
    );
  });
});
