import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { createBranch } from "@/modules/sites/branches";
import { createLocation, createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  postAdjustment,
  postOpeningBalance,
  postStatusChange,
  postWriteOff,
  reverseDocument,
} from "./operations";
import { reconcileBalances } from "./queries";
import { addDays, businessDate } from "./rules";
import {
  addShipmentLine,
  cancelShipment,
  createShipment,
  dispatchShipment,
  getShipment,
  listShipments,
  receiveShipment,
  removeShipmentLine,
} from "./shipments";
import { reconcileValuations } from "./valuation-queries";

let ctx: TenantContext;
let units: Record<string, string>;
let cairo: string;
let giza: string;
let gizaShelf: string;
let flour: string; // kg
let milk: string; // l, lot + expiry
const today = businessDate("Africa/Cairo");

async function stock(productId: string, warehouseId: string, status = "AVAILABLE") {
  const rows = await getDb().stockBalance.findMany({
    where: {
      organizationId: ctx.organizationId,
      productId,
      warehouseId,
      stockStatus: status as never,
    },
  });
  return rows.reduce((s, r) => s.plus(r.onHandQuantity.toString()), new Decimal(0)).toFixed();
}
async function value(productId: string, warehouseId: string) {
  const v = await getDb().stockValuation.findFirst({
    where: { organizationId: ctx.organizationId, productId, warehouseId },
  });
  return v?.totalValue.toFixed() ?? "0";
}
async function balanceId(productId: string, warehouseId: string, lotCode?: string) {
  const b = await getDb().stockBalance.findFirstOrThrow({
    where: {
      organizationId: ctx.organizationId,
      productId,
      warehouseId,
      stockStatus: "AVAILABLE",
      ...(lotCode ? { lot: { lotCode } } : {}),
    },
  });
  return b.id;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("shipments"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const b1 = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "CENTRAL_KITCHEN" })).id;
  const b2 = (await createBranch(ctx, { code: "GIZ", name: "Giza", type: "RESTAURANT" })).id;
  cairo = (await createWarehouse(ctx, { branchId: b1, code: "CK", name: "Central", type: "MAIN" }))
    .id;
  giza = (
    await createWarehouse(ctx, { branchId: b2, code: "GZ", name: "Giza store", type: "MAIN" })
  ).id;
  gizaShelf = (
    await createLocation(ctx, giza, {
      code: "COLD-1",
      name: "Cold room",
      temperatureZone: "CHILLED",
    })
  ).id;
  flour = (
    await createProduct(ctx, {
      sku: "FLOUR",
      nameEn: "Flour",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  milk = (
    await createProduct(ctx, {
      sku: "MILK",
      nameEn: "Milk",
      type: "RAW_MATERIAL",
      baseUomId: units.l,
      lotTracking: "LOT_AND_EXPIRY",
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: cairo,
    productId: flour,
    quantity: "100",
    uomId: units.kg,
    unitCost: "20",
  });
  await postOpeningBalance(ctx, {
    warehouseId: cairo,
    productId: milk,
    lotCode: "M-1",
    expiresOn: addDays(today, 10),
    quantity: "50",
    uomId: units.l,
    unitCost: "30",
  });
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
  expect(await reconcileValuations(ctx)).toEqual([]);
  await getDb().$disconnect();
});

describe("shipments", () => {
  it("dispatches to in-transit at the source and receives at the destination with value", async () => {
    const { id, number } = await createShipment(ctx, {
      fromWarehouseId: cairo,
      toWarehouseId: giza,
    });
    expect(number).toMatch(/^SHP-\d{4}-\d{6}$/);
    await addShipmentLine(ctx, id, {
      balanceId: await balanceId(flour, cairo),
      quantity: "40",
      uomId: units.kg,
    });
    await addShipmentLine(ctx, id, {
      balanceId: await balanceId(milk, cairo, "M-1"),
      quantity: "20000",
      uomId: units.ml,
    });
    await expectAppError(
      addShipmentLine(ctx, id, {
        balanceId: await balanceId(flour, cairo),
        quantity: "1000",
        uomId: units.kg,
      }),
      "BUSINESS_RULE_VIOLATION",
    ); // more than available
    const totalBefore = new Decimal(await value(flour, cairo)).plus(await value(milk, cairo));

    await dispatchShipment(ctx, id);
    expect(await stock(flour, cairo, "AVAILABLE")).toBe("60");
    expect(await stock(flour, cairo, "IN_TRANSIT")).toBe("40");
    expect(await stock(milk, cairo, "IN_TRANSIT")).toBe("20");
    expect(await value(flour, cairo)).toBe("2000"); // value stays with the source while in transit
    await expectAppError(dispatchShipment(ctx, id), "BUSINESS_RULE_VIOLATION");

    // In-transit stock cannot be touched by manual operations.
    await expectAppError(
      postWriteOff(ctx, {
        warehouseId: cairo,
        productId: flour,
        stockStatus: "IN_TRANSIT",
        quantity: "1",
        uomId: units.kg,
        reasonCode: "DAMAGED",
      }),
      "VALIDATION_FAILED",
    );

    const shipment = await getShipment(ctx, id);
    const [flourLine, milkLine] = shipment.lines;
    // Shipment documents change only through the shipment.
    await expectAppError(
      reverseDocument(ctx, shipment.dispatchDoc!.id, { reasonCode: "ENTERED_IN_ERROR" }),
      "BUSINESS_RULE_VIOLATION",
    );
    // Short delivery needs a reason; over-receipt is refused.
    await expectAppError(
      receiveShipment(ctx, id, {
        lines: [
          { lineId: flourLine.id, receivedQuantity: "38" },
          { lineId: milkLine.id, receivedQuantity: "20000" },
        ],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      receiveShipment(ctx, id, {
        lines: [
          { lineId: flourLine.id, receivedQuantity: "41" },
          { lineId: milkLine.id, receivedQuantity: "20000" },
        ],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await receiveShipment(ctx, id, {
      toLocationId: gizaShelf,
      lines: [
        { lineId: flourLine.id, receivedQuantity: "38", shortageReason: "DAMAGED_IN_TRANSIT" },
        { lineId: milkLine.id, receivedQuantity: "20000" },
      ],
    });
    expect(await stock(flour, cairo, "IN_TRANSIT")).toBe("0");
    expect(await stock(milk, cairo, "IN_TRANSIT")).toBe("0");
    expect(await stock(flour, giza)).toBe("38");
    expect(await stock(milk, giza)).toBe("20");
    expect(await value(flour, giza)).toBe("760"); // 38 × 20
    expect(await value(milk, giza)).toBe("600");
    // The lot travelled with the stock, into the chosen location.
    const milkAtGiza = await getDb().stockBalance.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, productId: milk, warehouseId: giza },
      include: { lot: true },
    });
    expect(milkAtGiza.lot?.lotCode).toBe("M-1");
    expect(milkAtGiza.locationId).toBe(gizaShelf);
    // Only the shortage left the books.
    const totalAfter = new Decimal(await value(flour, cairo))
      .plus(await value(milk, cairo))
      .plus(await value(flour, giza))
      .plus(await value(milk, giza));
    expect(totalBefore.minus(totalAfter).toFixed()).toBe("40"); // 2 kg × 20

    const received = await getShipment(ctx, id);
    expect(received.status).toBe("RECEIVED");
    expect(received.lines[0]).toMatchObject({ shortageReason: "DAMAGED_IN_TRANSIT" });
    expect(received.lines[0].receivedQuantity?.toFixed()).toBe("38");
    // Shipment postings are corrected from the shipment, not reversed directly.
    await expectAppError(
      reverseDocument(ctx, received.receiptDoc!.id, { reasonCode: "ENTERED_IN_ERROR" }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("recalls a shipment in transit and cancels drafts", async () => {
    const { id } = await createShipment(ctx, { fromWarehouseId: cairo, toWarehouseId: giza });
    await addShipmentLine(ctx, id, {
      balanceId: await balanceId(flour, cairo),
      quantity: "10",
      uomId: units.kg,
    });
    await dispatchShipment(ctx, id);
    expect(await stock(flour, cairo, "IN_TRANSIT")).toBe("10");
    await expectAppError(cancelShipment(ctx, id, { reason: "" }), "VALIDATION_FAILED");
    await cancelShipment(ctx, id, { reason: "Truck broke down" });
    expect(await stock(flour, cairo, "IN_TRANSIT")).toBe("0");
    expect(await stock(flour, cairo, "AVAILABLE")).toBe("60");
    expect((await getShipment(ctx, id)).status).toBe("CANCELLED");
    await expectAppError(receiveShipment(ctx, id, { lines: [] }), "VALIDATION_FAILED");

    const draft = await createShipment(ctx, { fromWarehouseId: cairo, toWarehouseId: giza });
    const line = await addShipmentLine(ctx, draft.id, {
      balanceId: await balanceId(flour, cairo),
      quantity: "1",
      uomId: units.kg,
    });
    await removeShipmentLine(ctx, draft.id, line.id);
    await expectAppError(dispatchShipment(ctx, draft.id), "BUSINESS_RULE_VIOLATION"); // no lines
    await cancelShipment(ctx, draft.id, { reason: "Not needed" });
    await expectAppError(
      createShipment(ctx, { fromWarehouseId: cairo, toWarehouseId: cairo }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("refuses expired or recalled stock, and stock that left the bucket after the draft", async () => {
    await postAdjustment(ctx, {
      warehouseId: cairo,
      productId: milk,
      direction: "INCREASE",
      lotCode: "M-OLD",
      expiresOn: addDays(today, -1),
      quantity: "5",
      uomId: units.l,
      reasonCode: "FOUND_STOCK",
    });
    const { id } = await createShipment(ctx, { fromWarehouseId: cairo, toWarehouseId: giza });
    await expectAppError(
      addShipmentLine(ctx, id, {
        balanceId: await balanceId(milk, cairo, "M-OLD"),
        quantity: "1",
        uomId: units.l,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await addShipmentLine(ctx, id, {
      balanceId: await balanceId(flour, cairo),
      quantity: "60",
      uomId: units.kg,
    });
    // The stock is quarantined before dispatch: dispatch must fail, nothing changes.
    await postStatusChange(ctx, {
      warehouseId: cairo,
      productId: flour,
      fromStatus: "AVAILABLE",
      toStatus: "QUARANTINE",
      quantity: "10",
      uomId: units.kg,
      reasonCode: "QUALITY_CHECK",
    });
    await expectAppError(dispatchShipment(ctx, id), "BUSINESS_RULE_VIOLATION");
    expect(await stock(flour, cairo, "IN_TRANSIT")).toBe("0");
    expect((await getShipment(ctx, id)).status).toBe("DRAFT");
  });

  it("lets the source dispatch and the destination receive, and hides shipments from others", async () => {
    const sender = await addMember(ctx, "warehouse", {
      scopeType: "WAREHOUSE",
      warehouseId: cairo,
    });
    const receiver = await addMember(ctx, "warehouse", {
      scopeType: "WAREHOUSE",
      warehouseId: giza,
    });
    const { id } = await createShipment(sender.ctx, {
      fromWarehouseId: cairo,
      toWarehouseId: giza,
    });
    await addShipmentLine(sender.ctx, id, {
      balanceId: await balanceId(flour, cairo),
      quantity: "5",
      uomId: units.kg,
    });
    // Outside their scope, warehouses are reported as not found (no probing).
    await expectAppError(dispatchShipment(receiver.ctx, id), "NOT_FOUND");
    await dispatchShipment(sender.ctx, id);
    const line = (await getShipment(receiver.ctx, id)).lines[0];
    await expectAppError(
      receiveShipment(sender.ctx, id, { lines: [{ lineId: line.id, receivedQuantity: "5" }] }),
      "NOT_FOUND",
    );
    await receiveShipment(receiver.ctx, id, {
      lines: [{ lineId: line.id, receivedQuantity: "5" }],
    });
    expect((await listShipments(receiver.ctx)).items.some((s) => s.number)).toBe(true);

    const { ctx: other } = await createTenant("shipments-other");
    await expectAppError(getShipment(other, id), "NOT_FOUND");
    expect((await listShipments(other)).total).toBe(0);
  });
});
