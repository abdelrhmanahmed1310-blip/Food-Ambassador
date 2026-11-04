import { beforeAll, describe, expect, it } from "vitest";
import {
  addSalesOrderLine,
  confirmSalesOrder,
  createCustomer,
  createSalesOrder,
  deliverSalesOrder,
} from "@/modules/b2b/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance, postWriteOff } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { exportStockHealthCsv, stockHealth } from "./stock";

/** Stock ageing, turnover and days on hand (ADR-106). */

let ctx: TenantContext;
let today: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("stock-health"));
  today = businessDate(ctx.timeZone);
  const kg = (await listUnits(ctx)).find((u) => u.code === "kg")!.id;
  const branchId = (
    await createBranch(ctx, { code: "CK", name: "Kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  const main = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" }))
    .id;
  const saffron = (
    await createProduct(ctx, {
      sku: "SAFFRON",
      nameEn: "Saffron",
      type: "RAW_MATERIAL",
      baseUomId: kg,
      lotTracking: "LOT",
    })
  ).id;
  const rice = (
    await createProduct(ctx, { sku: "RICE", nameEn: "Rice", type: "RAW_MATERIAL", baseUomId: kg })
  ).id;
  // Saffron: 10 kg at 5 in one lot, 2 kg written off (40 left).
  await postOpeningBalance(ctx, {
    warehouseId: main,
    productId: saffron,
    lotCode: "S-1",
    quantity: "10",
    uomId: kg,
    unitCost: "5",
  });
  const lot = await getDb().inventoryLot.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, lotCode: "S-1" },
  });
  await postWriteOff(ctx, {
    warehouseId: main,
    productId: saffron,
    lotId: lot.id,
    stockStatus: "AVAILABLE",
    quantity: "2",
    uomId: kg,
    reasonCode: "DAMAGED",
  });
  // The lot came in 100 days ago and expired yesterday.
  await getDb().inventoryLot.update({
    where: { id: lot.id },
    data: {
      firstReceivedAt: new Date(`${addDays(today, -100)}T12:00:00Z`),
      expiresOn: new Date(`${addDays(today, -1)}T00:00:00Z`),
    },
  });
  // Rice without lots: 20 kg at 2, 5 kg delivered to a customer (30 left).
  await postOpeningBalance(ctx, {
    warehouseId: main,
    productId: rice,
    quantity: "20",
    uomId: kg,
    unitCost: "2",
  });
  const customerId = (await createCustomer(ctx, { code: "HOTEL", name: "Hotel" })).id;
  const order = await createSalesOrder(ctx, { customerId, warehouseId: main });
  await addSalesOrderLine(ctx, order.id, {
    productId: rice,
    quantity: "5",
    uomId: kg,
    unitPrice: "4",
  });
  await confirmSalesOrder(ctx, order.id);
  await deliverSalesOrder(ctx, order.id, {});
}, 60_000);

describe("stock health (ADR-106)", () => {
  it("ages stock on hand, values it at average cost and flags expired and slow stock", async () => {
    const r = await stockHealth(ctx, { from: today, to: today });
    const by = (sku: string) => r.products.find((p) => p.product.sku === sku)!;
    expect([by("SAFFRON").onHandValue.toFixed(2), by("SAFFRON").oldestAgeDays]).toEqual([
      "40.00",
      100,
    ]);
    expect(by("SAFFRON").buckets.D91_180.toFixed(2)).toBe("40.00");
    expect(by("SAFFRON").expiredValue.toFixed(2)).toBe("40.00");
    expect(by("SAFFRON").slowMover).toBe(true);
    // Rice arrived today and is aged first in first out.
    expect([by("RICE").onHandValue.toFixed(2), by("RICE").buckets.D0_30.toFixed(2)]).toEqual([
      "30.00",
      "30.00",
    ]);
    expect(by("RICE").slowMover).toBe(false);
    expect(r.slowMovers).toBe(1);
  });

  it("measures usage, turnover and days on hand from the ledger", async () => {
    const r = await stockHealth(ctx, { from: today, to: today });
    expect([r.total.opening.toFixed(2), r.total.closing.toFixed(2)]).toEqual(["0.00", "70.00"]);
    // Delivered 5 kg of rice at 2 = 10 used; 2 kg of saffron at 5 = 10 written off (not usage).
    expect([r.total.usage.toFixed(2), r.total.writtenOff.toFixed(2)]).toEqual(["10.00", "10.00"]);
    // 10 used over an average stock of (0 + 70) / 2 = 35; 70 left at 10 a day = 7 days.
    expect(r.total.turnover?.toFixed(4)).toBe("0.2857");
    expect(r.total.daysOnHand?.toFixed(1)).toBe("7.0");
    const rice = r.products.find((p) => p.product.sku === "RICE")!;
    expect(rice.daysOnHand?.toFixed(1)).toBe("3.0");
    // A later period sees today's closing as its opening, with no usage.
    const tomorrow = addDays(today, 1);
    const later = await stockHealth(ctx, { from: tomorrow, to: tomorrow });
    expect([
      later.total.opening.toFixed(2),
      later.total.usage.toFixed(2),
      later.total.daysOnHand,
    ]).toEqual(["70.00", "0.00", null]);
    const csv = await exportStockHealthCsv(ctx, { from: today, to: today });
    expect(csv).toContain("MAIN,SAFFRON,Saffron,8,kg,40.00");
  });

  it("needs stock value rights and stays inside the organization", async () => {
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(stockHealth(cashier.ctx, { from: today, to: today }), "FORBIDDEN");
    const { ctx: other } = await createTenant("stock-health-other");
    const r = await stockHealth(other, { from: today, to: today });
    expect([r.products, r.total.closing.toFixed()]).toEqual([[], "0"]);
  });
});
