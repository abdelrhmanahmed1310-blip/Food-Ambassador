import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { reconcileBalances } from "@/modules/inventory/queries";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { postReceipt, reverseReceipt } from "@/modules/procurement/receipts";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createLocation, createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { inspectReceiptLine, listInspections, listPendingInspections } from "./inspections";
import { archivePutawayRule, createPutawayRule, putAway, putawayWorklist } from "./putaway";

/** Receiving inspection and directed put-away (ADR-101). */

let ctx: TenantContext;
let main: string;
let dock: string;
let chilled: string;
let dry: string;
let milk: string;
let rice: string;
let receiptId: string;

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
    include: { location: { select: { code: true } } },
  });
  return rows
    .map((r) => `${r.location?.code ?? "-"}:${r.stockStatus}:${r.onHandQuantity.toString()}`)
    .sort();
}

beforeAll(async () => {
  ({ ctx } = await createTenant("wms"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (
    await createBranch(ctx, { code: "CK", name: "Kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  main = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  dock = (
    await createLocation(ctx, main, {
      code: "DOCK",
      name: "Receiving dock",
      temperatureZone: "CHILLED",
      zone: "RECEIVING",
    })
  ).id;
  chilled = (
    await createLocation(ctx, main, { code: "CH-A", name: "Chiller A", temperatureZone: "CHILLED" })
  ).id;
  dry = (
    await createLocation(ctx, main, {
      code: "DRY-A",
      name: "Dry store A",
      temperatureZone: "AMBIENT",
    })
  ).id;
  milk = (
    await createProduct(ctx, {
      sku: "MILK",
      nameEn: "Milk",
      type: "RAW_MATERIAL",
      baseUomId: units.l,
      lotTracking: "LOT",
      storageRequirement: "CHILLED",
      inspectOnReceipt: "on",
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
  const supplierId = (await createSupplier(ctx, { code: "FARM", name: "Farm Co" })).id;
  const { id: orderId } = await createOrder(ctx, { supplierId, warehouseId: main });
  await addOrderLine(ctx, orderId, {
    productId: milk,
    quantity: "10",
    uomId: units.l,
    unitPrice: "3",
  });
  await addOrderLine(ctx, orderId, {
    productId: rice,
    quantity: "20",
    uomId: units.kg,
    unitPrice: "2",
  });
  await submitOrder(ctx, orderId);
  const order = await getOrder(ctx, orderId);
  const lineOf = (p: string) => order.lines.find((l) => l.productId === p)!.id;
  // No location given: the goods land on the only receiving location.
  receiptId = (
    await postReceipt(ctx, orderId, {
      lines: [
        {
          purchaseOrderLineId: lineOf(milk),
          receivedQuantity: "10",
          unitPrice: "3",
          lotCode: "M-1",
          temperatureCelsius: "4",
        },
        { purchaseOrderLineId: lineOf(rice), receivedQuantity: "20", unitPrice: "2" },
      ],
    })
  ).id;
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
});

describe("receiving inspection (ADR-101)", () => {
  it("products inspected on receipt wait in quarantine at the receiving location", async () => {
    expect(await stock(milk)).toEqual(["DOCK:QUARANTINE:10"]);
    expect(await stock(rice)).toEqual(["DOCK:AVAILABLE:20"]);
    const pending = await listPendingInspections(ctx);
    expect(pending.map((p) => p.product.sku)).toEqual(["MILK"]);
  });

  it("splits the line into accepted and rejected stock through the ledger, once", async () => {
    const [line] = await listPendingInspections(ctx);
    const checks = { packagingOk: "yes", labellingOk: "yes", conditionOk: "yes" };
    await expectRule(
      inspectReceiptLine(ctx, line.id, { ...checks, acceptedQuantity: "9" }),
      "REJECTION_REASON_REQUIRED",
    );
    await expectRule(
      inspectReceiptLine(ctx, line.id, { ...checks, acceptedQuantity: "11" }),
      "ACCEPTED_OUT_OF_RANGE",
    );
    await expectRule(
      inspectReceiptLine(ctx, line.id, { ...checks, conditionOk: "no", acceptedQuantity: "10" }),
      "INSPECTION_NOTE_REQUIRED",
    );
    const done = await inspectReceiptLine(ctx, line.id, {
      ...checks,
      acceptedQuantity: "9",
      temperatureCelsius: "3.5",
      rejectionReason: "One bottle leaking",
    });
    expect([done.decision, done.accepted, done.rejected]).toEqual(["PARTIAL", "9", "1"]);
    expect(await stock(milk)).toEqual(["DOCK:AVAILABLE:9", "DOCK:REJECTED:1"]);
    expect(await listPendingInspections(ctx)).toEqual([]);
    await expectRule(
      inspectReceiptLine(ctx, line.id, { ...checks, acceptedQuantity: "10" }),
      "ALREADY_INSPECTED",
    );
    expect((await listInspections(ctx))[0]).toMatchObject({ decision: "PARTIAL" });
    // Evidence: never changed, and the receipt can no longer be reversed.
    await expect(
      getDb().receiptInspection.update({ where: { id: done.id }, data: { note: "x" } }),
    ).rejects.toThrow();
    await expectRule(
      reverseReceipt(ctx, receiptId, { reasonCode: "ENTERED_IN_ERROR" }),
      "RECEIPT_INSPECTED",
    );
  });

  it("is limited to people who release quarantine", async () => {
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(listPendingInspections(cashier.ctx), "FORBIDDEN");
  });
});

describe("directed put-away (ADR-101)", () => {
  it("rules point only at storage places at the right temperature", async () => {
    await expectRule(
      createPutawayRule(ctx, main, { priority: "5", locationId: dock }),
      "PUTAWAY_LOCATION_NOT_STORAGE",
    );
    await expectRule(
      createPutawayRule(ctx, main, {
        priority: "5",
        storageRequirement: "CHILLED",
        locationId: dry,
      }),
      "PUTAWAY_TEMPERATURE_MISMATCH",
    );
    await expectAppError(
      createPutawayRule(ctx, main, { priority: "0", locationId: chilled }),
      "VALIDATION_FAILED",
    );
    const stale = await createPutawayRule(ctx, main, {
      priority: "1",
      productId: milk,
      locationId: chilled,
    });
    await archivePutawayRule(ctx, stale.id);
    await createPutawayRule(ctx, main, {
      priority: "10",
      storageRequirement: "CHILLED",
      locationId: chilled,
    });
  });

  it("lists received stock with a suggestion and puts it away through the ledger", async () => {
    const list = await putawayWorklist(ctx, main);
    const bySku = (sku: string) => list.items.find((i) => i.product.sku === sku)!;
    expect(bySku("MILK").suggestion).toMatchObject({ source: "RULE", locationId: chilled });
    expect(bySku("RICE").suggestion).toEqual({ source: "NONE" });
    expect(bySku("RICE").targets.map((t) => t.code)).toEqual(["DRY-A"]);
    // Rejected stock is not put away.
    expect(list.items.map((i) => i.product.sku).sort()).toEqual(["MILK", "RICE"]);

    await expectRule(
      putAway(ctx, { balanceId: bySku("RICE").id, toLocationId: chilled, quantity: "20" }),
      "PUTAWAY_TEMPERATURE_MISMATCH",
    );
    await expectRule(
      putAway(ctx, { balanceId: bySku("MILK").id, toLocationId: chilled, quantity: "9.5" }),
      "INSUFFICIENT_STOCK",
    );
    await putAway(ctx, { balanceId: bySku("MILK").id, toLocationId: chilled, quantity: "9" });
    await putAway(ctx, { balanceId: bySku("RICE").id, toLocationId: dry, quantity: "15" });
    expect(await stock(milk)).toEqual(["CH-A:AVAILABLE:9", "DOCK:REJECTED:1"]);
    expect(await stock(rice)).toEqual(["DOCK:AVAILABLE:5", "DRY-A:AVAILABLE:15"]);
    // The rest of the rice now has a suggestion: where it already is.
    const after = await putawayWorklist(ctx, main);
    expect(after.items.map((i) => [i.product.sku, i.suggestion.source])).toEqual([
      ["RICE", "SAME_PRODUCT"],
    ]);
  });

  it("keeps other organizations out", async () => {
    const { ctx: other } = await createTenant("wms-other");
    await expectAppError(putawayWorklist(other, main), "NOT_FOUND");
    await expectAppError(
      createPutawayRule(other, main, { priority: "1", locationId: chilled }),
      "NOT_FOUND",
    );
  });
});
