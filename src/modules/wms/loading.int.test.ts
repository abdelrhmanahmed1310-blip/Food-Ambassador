import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addSalesOrderLine,
  confirmSalesOrder,
  createCustomer,
  createSalesOrder,
  getSalesOrder,
} from "@/modules/b2b/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { reconcileBalances } from "@/modules/inventory/queries";
import { createBranch } from "@/modules/sites/branches";
import { createLocation, createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addToLoad,
  cancelLoad,
  confirmLoaded,
  createLoad,
  dispatchLoad,
  getLoad,
  packUnit,
  removeFromLoad,
  removePackUnit,
} from "./loading";
import {
  cancelPickList,
  confirmPick,
  createPickList,
  deliverPickList,
  getPickList,
} from "./picking";

/** Packing, loading and dispatch (ADR-103). */

let ctx: TenantContext;
let units: Record<string, string>;
let main: string;
let customerId: string;
let yogurt: string;

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

async function stock() {
  const rows = await getDb().stockBalance.findMany({
    where: { organizationId: ctx.organizationId, productId: yogurt, onHandQuantity: { gt: 0 } },
    include: { location: { select: { code: true } } },
  });
  return rows.map((r) => `${r.location?.code ?? "-"}:${r.onHandQuantity.toString()}`).sort();
}

/** A confirmed order, fully picked. */
async function picked(quantity: string) {
  const o = await createSalesOrder(ctx, { customerId, warehouseId: main });
  await addSalesOrderLine(ctx, o.id, {
    productId: yogurt,
    quantity,
    uomId: units.kg,
    unitPrice: "10",
  });
  await confirmSalesOrder(ctx, o.id);
  const list = await createPickList(ctx, o.id);
  const view = await getPickList(ctx, list.id);
  await confirmPick(ctx, list.id, {
    lines: view.lines.map((l) => ({ id: l.id, pickedQuantity: l.plannedQuantity.toString() })),
  });
  return { orderId: o.id, listId: list.id, lineId: view.lines[0].id };
}

beforeAll(async () => {
  ({ ctx } = await createTenant("loading"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (
    await createBranch(ctx, { code: "CK", name: "Kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  main = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  const pick1 = (
    await createLocation(ctx, main, {
      code: "PICK-1",
      name: "Pick face",
      temperatureZone: "CHILLED",
      zone: "PICKING",
    })
  ).id;
  await createLocation(ctx, main, {
    code: "DSP-C",
    name: "Chilled dispatch",
    temperatureZone: "CHILLED",
    zone: "DISPATCH",
  });
  yogurt = (
    await createProduct(ctx, {
      sku: "YOG",
      nameEn: "Yogurt",
      type: "FINISHED_GOOD",
      baseUomId: units.kg,
      storageRequirement: "CHILLED",
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: main,
    locationId: pick1,
    productId: yogurt,
    quantity: "50",
    uomId: units.kg,
    unitCost: "5",
  });
  customerId = (await createCustomer(ctx, { code: "HOTEL", name: "Nile Hotel" })).id;
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
});

describe("packing and loading (ADR-103)", () => {
  it("packs picked stock into numbered units, never more than picked", async () => {
    const a = await picked("10");
    await expectRule(
      packUnit(ctx, a.listId, {
        type: "CARTON",
        lines: [{ pickListLineId: a.lineId, quantity: "11" }],
      }),
      "PACK_MORE_THAN_PICKED",
    );
    const first = await packUnit(ctx, a.listId, {
      type: "CARTON",
      grossWeightKg: "6.4",
      lines: [{ pickListLineId: a.lineId, quantity: "6" }],
    });
    expect(first.number).toMatch(/^PKU-/);
    // Empty lines: the rest goes into this unit.
    const second = await packUnit(ctx, a.listId, { type: "CRATE" });
    await expectRule(packUnit(ctx, a.listId, { type: "CARTON" }), "NOTHING_TO_PACK");
    await removePackUnit(ctx, second.id);
    await packUnit(ctx, a.listId, { type: "CRATE" });

    const b = await picked("5");
    const load = await createLoad(ctx, {
      warehouseId: main,
      vehicleRef: "CAI 1234",
      driverName: "Hassan",
    });
    expect(load.number).toMatch(/^LOD-/);
    await expectRule(addToLoad(ctx, load.id, b.listId), "PACKING_INCOMPLETE");
    await packUnit(ctx, b.listId, { type: "BAG" });
    await addToLoad(ctx, load.id, a.listId);
    await addToLoad(ctx, load.id, b.listId);
    await expectRule(addToLoad(ctx, load.id, b.listId), "PICK_LIST_ON_LOAD");

    // On a load, the lists ship only with it.
    await expectRule(deliverPickList(ctx, a.listId), "PICK_LIST_ON_LOAD");
    await expectRule(cancelPickList(ctx, a.listId, { reason: "x" }), "PICK_LIST_ON_LOAD");
    await expectRule(removePackUnit(ctx, first.id), "PACK_UNIT_FIXED");
    await expectRule(packUnit(ctx, b.listId, { type: "BAG" }), "PICK_LIST_ON_LOAD");

    // Loading confirmation, by number as a scanner would send it.
    const view = await getLoad(ctx, load.id);
    expect([view.unitCount, view.loadedCount, view.hasCold]).toEqual([3, 0, true]);
    const numbers = view.pickLists.flatMap((l) => l.packUnits.map((u) => u.number));
    await confirmLoaded(ctx, load.id, { unit: numbers[0].toLowerCase() });
    await expectRule(confirmLoaded(ctx, load.id, { unit: numbers[0] }), "ALREADY_LOADED");
    await expectRule(
      confirmLoaded(ctx, load.id, { unit: "PKU-0000-000000" }),
      "PACK_UNIT_NOT_ON_LOAD",
    );
    await confirmLoaded(ctx, load.id, { unit: numbers[1] });
    await expectRule(dispatchLoad(ctx, load.id, {}), "LOAD_NOT_FULLY_LOADED");
    await confirmLoaded(ctx, load.id, { unit: numbers[2] });

    // Dispatch: the vehicle temperature is needed for chilled goods.
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(dispatchLoad(cashier.ctx, load.id, {}), "FORBIDDEN");
    await expectRule(dispatchLoad(ctx, load.id, {}), "VEHICLE_TEMPERATURE_REQUIRED");
    expect(await stock()).toEqual(["DSP-C:15", "PICK-1:35"]);
    const sent = await dispatchLoad(ctx, load.id, {
      vehicleTemperatureCelsius: "3.5",
      sealNumber: "S-77",
    });
    expect(sent.deliveries).toHaveLength(2);
    expect(await stock()).toEqual(["PICK-1:35"]);
    expect((await getSalesOrder(ctx, a.orderId)).status).toBe("DELIVERED");
    expect((await getPickList(ctx, b.listId)).status).toBe("DELIVERED");
    const done = await getLoad(ctx, load.id);
    expect([done.status, done.sealNumber, done.vehicleTemperatureCelsius?.toString()]).toEqual([
      "DISPATCHED",
      "S-77",
      "3.5",
    ]);
    // Evidence: the load and its units are frozen.
    await expect(
      getDb().load.update({ where: { id: load.id }, data: { sealNumber: "x" } }),
    ).rejects.toThrow();
    await expect(getDb().packUnit.delete({ where: { id: first.id } })).rejects.toThrow();
  });

  it("cancelling a load or taking a list off leaves it picked and packed", async () => {
    const c = await picked("4");
    await packUnit(ctx, c.listId, { type: "CARTON" });
    const load = await createLoad(ctx, { warehouseId: main, vehicleRef: "VAN 2" });
    await addToLoad(ctx, load.id, c.listId);
    const unit = (await getLoad(ctx, load.id)).pickLists[0].packUnits[0];
    await confirmLoaded(ctx, load.id, { unit: unit.id });
    await removeFromLoad(ctx, load.id, c.listId);
    await addToLoad(ctx, load.id, c.listId);
    expect((await getLoad(ctx, load.id)).loadedCount).toBe(0);
    await expectAppError(cancelLoad(ctx, load.id, { reason: "" }), "VALIDATION_FAILED");
    await cancelLoad(ctx, load.id, { reason: "Van broke down" });
    await expectRule(addToLoad(ctx, load.id, c.listId), "LOAD_NOT_OPEN");
    // Back to a plain picked list: cancelling it unpacks and moves the stock back.
    await cancelPickList(ctx, c.listId, { reason: "Customer cancelled" });
    expect(await stock()).toEqual(["PICK-1:35"]);
    expect(await getDb().packUnit.count({ where: { pickListId: c.listId } })).toBe(0);
  });

  it("keeps other organizations out", async () => {
    const { ctx: other } = await createTenant("loading-other");
    await expectAppError(createLoad(other, { warehouseId: main, vehicleRef: "X" }), "NOT_FOUND");
  });
});
