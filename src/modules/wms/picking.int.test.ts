import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addSalesOrderLine,
  cancelSalesOrder,
  confirmSalesOrder,
  createCustomer,
  createSalesOrder,
  deliverSalesOrder,
  getSalesOrder,
} from "@/modules/b2b/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { reconcileBalances } from "@/modules/inventory/queries";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import { createLocation, createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  cancelPickList,
  confirmPick,
  createPickList,
  createWave,
  deliverPickList,
  getPickList,
  getWave,
  ordersToPick,
} from "./picking";

/** Pick lists, waves and delivery from picked stock (ADR-102). */

let ctx: TenantContext;
let units: Record<string, string>;
let main: string;
let customerId: string;
let yogurt: string;
let rice: string;
let pick1: string;
let chillA: string;

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

async function stock(productId: string) {
  const rows = await getDb().stockBalance.findMany({
    where: { organizationId: ctx.organizationId, productId, onHandQuantity: { gt: 0 } },
    include: { location: { select: { code: true } }, lot: { select: { lotCode: true } } },
  });
  return rows
    .map(
      (r) => `${r.location?.code ?? "-"}:${r.lot?.lotCode ?? "-"}:${r.onHandQuantity.toString()}`,
    )
    .sort();
}

async function order(productId: string, quantity: string) {
  const o = await createSalesOrder(ctx, { customerId, warehouseId: main });
  await addSalesOrderLine(ctx, o.id, { productId, quantity, uomId: units.kg, unitPrice: "10" });
  await confirmSalesOrder(ctx, o.id);
  return o.id;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("picking"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const today = businessDate(ctx.timeZone);
  const branchId = (
    await createBranch(ctx, { code: "CK", name: "Kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  main = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  const loc = (code: string, zone: string) =>
    createLocation(ctx, main, { code, name: code, temperatureZone: "CHILLED", zone }).then(
      (l) => l.id,
    );
  pick1 = await loc("PICK-1", "PICKING");
  chillA = await loc("CH-A", "STORAGE");
  await loc("DSP-C", "DISPATCH");
  yogurt = (
    await createProduct(ctx, {
      sku: "YOG",
      nameEn: "Yogurt",
      type: "FINISHED_GOOD",
      baseUomId: units.kg,
      lotTracking: "LOT",
      storageRequirement: "CHILLED",
    })
  ).id;
  rice = (
    await createProduct(ctx, {
      sku: "RICE",
      nameEn: "Rice",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: main,
    locationId: chillA,
    productId: yogurt,
    lotCode: "Y-OLD",
    expiresOn: addDays(today, 3),
    quantity: "10",
    uomId: units.kg,
    unitCost: "5",
  });
  await postOpeningBalance(ctx, {
    warehouseId: main,
    locationId: pick1,
    productId: yogurt,
    lotCode: "Y-NEW",
    expiresOn: addDays(today, 9),
    quantity: "20",
    uomId: units.kg,
    unitCost: "5",
  });
  await postOpeningBalance(ctx, {
    warehouseId: main,
    productId: rice,
    quantity: "50",
    uomId: units.kg,
    unitCost: "2",
  });
  customerId = (await createCustomer(ctx, { code: "HOTEL", name: "Nile Hotel" })).id;
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
});

describe("pick lists (ADR-102)", () => {
  let first: string; // order 1: 15 kg
  let firstList: string;

  it("plans first-expiring stock first and holds it against other lists", async () => {
    first = await order(yogurt, "15");
    const list = await createPickList(ctx, first);
    expect(list.number).toMatch(/^PCK-/);
    expect(list.shortages).toEqual([]);
    firstList = list.id;
    const view = await getPickList(ctx, list.id);
    expect(
      view.lines.map((l) => [
        l.lot?.lotCode,
        l.location?.code,
        l.staging.code,
        l.plannedQuantity.toString(),
      ]),
    ).toEqual([
      ["Y-OLD", "CH-A", "DSP-C", "10"],
      ["Y-NEW", "PICK-1", "DSP-C", "5"],
    ]);
    // Walk order is by location.
    expect(view.walk.map((l) => l.location?.code)).toEqual(["CH-A", "PICK-1"]);
    await expectRule(createPickList(ctx, first), "PICK_LIST_OPEN");
    await expectRule(deliverSalesOrder(ctx, first, {}), "PICK_LIST_OPEN");
    await expectRule(cancelSalesOrder(ctx, first, { reason: "x" }), "PICK_LIST_OPEN");
    // Ambient goods need an ambient dispatch area.
    const riceOrder = await order(rice, "5");
    await expectRule(createPickList(ctx, riceOrder), "PICK_NO_DISPATCH_LOCATION");
    await cancelSalesOrder(ctx, riceOrder, { reason: "Test" });
  });

  it("a wave plans what is left after the open list and reports the shortage", async () => {
    const second = await order(yogurt, "20");
    expect((await ordersToPick(ctx, main)).map((o) => o.id)).toEqual([second]);
    const wave = await createWave(ctx, { warehouseId: main, orderIds: [second] });
    expect(wave.number).toMatch(/^WAV-/);
    expect(wave.lists[0].shortages).toEqual([{ sku: "YOG", short: "5" }]);
    const sheet = (await getWave(ctx, wave.id)).sheet;
    expect(sheet.map((r) => [r.locationCode, r.lot?.lotCode, r.quantity.toFixed()])).toEqual([
      ["PICK-1", "Y-NEW", "15"],
    ]);
    // Cancel the planned list: its hold is released.
    await expectAppError(
      cancelPickList(ctx, wave.lists[0].id, { reason: "" }),
      "VALIDATION_FAILED",
    );
    await cancelPickList(ctx, wave.lists[0].id, { reason: "Customer moved the date" });
    await expectRule(cancelPickList(ctx, wave.lists[0].id, { reason: "x" }), "PICK_LIST_STATUS");
  });

  it("picking moves stock to dispatch; staged stock is not used by plain deliveries", async () => {
    const view = await getPickList(ctx, firstList);
    const [a, b] = view.lines;
    await expectRule(
      confirmPick(ctx, firstList, {
        lines: [
          { id: a.id, pickedQuantity: "10" },
          { id: b.id, pickedQuantity: "4" },
        ],
      }),
      "PICK_SHORT_REASON_REQUIRED",
    );
    await expectRule(
      confirmPick(ctx, firstList, { lines: [{ id: a.id, pickedQuantity: "10" }] }),
      "PICK_LINES_MISSING",
    );
    await confirmPick(ctx, firstList, {
      lines: [
        { id: a.id, pickedQuantity: "10" },
        { id: b.id, pickedQuantity: "4", shortReason: "One tub damaged" },
      ],
    });
    expect(await stock(yogurt)).toEqual(["DSP-C:Y-NEW:4", "DSP-C:Y-OLD:10", "PICK-1:Y-NEW:16"]);
    // The picked plan is fixed now.
    await expect(
      getDb().pickListLine.update({ where: { id: a.id }, data: { pickedQuantity: "1" } }),
    ).rejects.toThrow();
    // A plain delivery of another order cannot take the staged 14 kg.
    const third = await order(yogurt, "20");
    await expectRule(deliverSalesOrder(ctx, third, {}), "INSUFFICIENT_STOCK_FOR_DELIVERY");
    await cancelSalesOrder(ctx, third, { reason: "Test" });
  });

  it("delivers exactly the picked stock from dispatch", async () => {
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(deliverPickList(cashier.ctx, firstList), "FORBIDDEN");
    const delivery = await deliverPickList(ctx, firstList);
    expect(delivery.number).toBeTruthy();
    expect(await stock(yogurt)).toEqual(["PICK-1:Y-NEW:16"]);
    const so = await getSalesOrder(ctx, first);
    expect(so.status).toBe("PARTIALLY_DELIVERED");
    expect((await getPickList(ctx, firstList)).status).toBe("DELIVERED");
    await expectRule(deliverPickList(ctx, firstList), "PICK_LIST_STATUS");
  });

  it("cancelling a picked list moves the stock back", async () => {
    const fourth = await order(yogurt, "6");
    const list = await createPickList(ctx, fourth);
    const view = await getPickList(ctx, list.id);
    await confirmPick(ctx, list.id, {
      lines: view.lines.map((l) => ({ id: l.id, pickedQuantity: l.plannedQuantity.toString() })),
    });
    expect(await stock(yogurt)).toEqual(["DSP-C:Y-NEW:6", "PICK-1:Y-NEW:10"]);
    await cancelPickList(ctx, list.id, { reason: "Order put on hold" });
    expect(await stock(yogurt)).toEqual(["PICK-1:Y-NEW:16"]);
    const after = await getPickList(ctx, list.id);
    expect([after.status, !!after.returnDocument]).toEqual(["CANCELLED", true]);
  });

  it("keeps other organizations and people without stock rights out", async () => {
    const cashier = await addMember(ctx, "cashier");
    const fifth = await order(yogurt, "1");
    await expectAppError(createPickList(cashier.ctx, fifth), "NOT_FOUND");
    const { ctx: other } = await createTenant("picking-other");
    await expectAppError(createPickList(other, fifth), "NOT_FOUND");
    await expectAppError(getPickList(other, firstList), "NOT_FOUND");
  });
});
