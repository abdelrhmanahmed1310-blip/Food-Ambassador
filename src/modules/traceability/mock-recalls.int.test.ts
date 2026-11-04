import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance, postWriteOff } from "@/modules/inventory/operations";
import { reconcileBalances } from "@/modules/inventory/queries";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { postReceipt } from "@/modules/procurement/receipts";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  cancelMockRecall,
  completeMockRecall,
  getMockRecall,
  listMockRecalls,
  startMockRecall,
} from "./mock-recalls";
import { searchLots } from "./trace";

/** Mock recall exercises (ADR-100). */

let ctx: TenantContext;
let branchId: string;
let main: string;
let delivered: string; // lot from a supplier: 100 kg in, 5 kg written off
let opening: string; // lot from an opening balance: no known origin

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

async function onHand(lotId: string) {
  const rows = await getDb().stockBalance.findMany({
    where: { organizationId: ctx.organizationId, lotId },
  });
  return rows.map((r) => `${r.stockStatus}:${r.onHandQuantity.toString()}`).sort();
}

beforeAll(async () => {
  ({ ctx } = await createTenant("mock-recall"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  branchId = (await createBranch(ctx, { code: "CK", name: "Kitchen", type: "CENTRAL_KITCHEN" })).id;
  main = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  const rice = (
    await createProduct(ctx, {
      sku: "RICE",
      nameEn: "Rice",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
      lotTracking: "LOT",
    })
  ).id;
  // Old stock from before the system (no known origin), then a delivery.
  await postOpeningBalance(ctx, {
    warehouseId: main,
    productId: rice,
    lotCode: "R-OLD",
    quantity: "8",
    uomId: units.kg,
    unitCost: "4",
  });
  const supplierId = (await createSupplier(ctx, { code: "GRAIN", name: "Grain Co" })).id;
  const { id: orderId } = await createOrder(ctx, { supplierId, warehouseId: main });
  await addOrderLine(ctx, orderId, {
    productId: rice,
    quantity: "100",
    uomId: units.kg,
    unitPrice: "4",
  });
  await submitOrder(ctx, orderId);
  const order = await getOrder(ctx, orderId);
  await postReceipt(ctx, orderId, {
    lines: [
      {
        purchaseOrderLineId: order.lines[0].id,
        receivedQuantity: "100",
        unitPrice: "4",
        lotCode: "R-1",
      },
    ],
  });
  const lots = await searchLots(ctx, "r-");
  delivered = lots.find((l) => l.lotCode === "R-1")!.id;
  opening = lots.find((l) => l.lotCode === "R-OLD")!.id;
  await postWriteOff(ctx, {
    warehouseId: main,
    productId: rice,
    lotId: delivered,
    stockStatus: "AVAILABLE",
    quantity: "5",
    uomId: units.kg,
    reasonCode: "SPOILED",
  });
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
});

describe("mock recalls (ADR-100)", () => {
  it("a drill that finds everything in time passes and leaves stock untouched", async () => {
    const before = await onHand(delivered);
    const drill = await startMockRecall(ctx, {
      branchId,
      lotId: delivered,
      scenario: "Supplier reports possible glass in lot R-1",
      targetMinutes: "240",
    });
    expect(drill.number).toMatch(/^MRC-/);
    const view = await getMockRecall(ctx, drill.id);
    expect(view.status).toBe("RUNNING");
    expect(
      [view.receivedQuantity, view.exitedQuantity, view.onHandQuantity].map((d) => d.toString()),
    ).toEqual(["100", "5", "95"]);
    expect([view.gapCount, view.supplierCount, view.counts.length]).toEqual([0, 1, 1]);

    await expectRule(
      completeMockRecall(ctx, drill.id, { counts: [] }),
      "MOCK_RECALL_COUNTS_MISSING",
    );
    const done = await completeMockRecall(ctx, drill.id, {
      counts: [{ id: view.counts[0].id, foundQuantity: "95" }],
      findings: "All sacks located in the dry store",
    });
    expect(done).toMatchObject({
      problems: [],
      accountedPercent: "100.00",
      withinTarget: true,
      nonConformance: null,
    });
    expect(await onHand(delivered)).toEqual(before);
    const finished = await getMockRecall(ctx, drill.id);
    expect(finished.status).toBe("COMPLETED");
    expect(finished.elapsedSeconds).toBeGreaterThanOrEqual(0);

    // Finished drills are evidence.
    await expectRule(
      completeMockRecall(ctx, drill.id, {
        counts: [{ id: view.counts[0].id, foundQuantity: "1" }],
      }),
      "MOCK_RECALL_FINISHED",
    );
    await expect(
      getDb().mockRecall.update({ where: { id: drill.id }, data: { findings: "changed" } }),
    ).rejects.toThrow();
    await expect(
      getDb().mockRecallCount.update({
        where: { id: view.counts[0].id },
        data: { foundQuantity: "1" },
      }),
    ).rejects.toThrow();
  });

  it("missing stock and a missed target open a non-conformance at the branch", async () => {
    const drill = await startMockRecall(ctx, {
      branchId,
      lotId: delivered,
      scenario: "Unannounced drill",
      targetMinutes: "60",
    });
    // The clock started 61 minutes ago.
    await getDb().mockRecall.update({
      where: { id: drill.id },
      data: { startedAt: new Date(Date.now() - 61 * 60_000) },
    });
    const view = await getMockRecall(ctx, drill.id);
    const done = await completeMockRecall(ctx, drill.id, {
      counts: [{ id: view.counts[0].id, foundQuantity: "90", note: "One sack not found" }],
    });
    expect(done.problems).toEqual(["TARGET_MISSED", "STOCK_DIFFERENCE", "NOT_ACCOUNTED"]);
    expect(done.accountedPercent).toBe("95.00");
    expect(done.withinTarget).toBe(false);
    const nc = await getDb().nonConformance.findUniqueOrThrow({
      where: { id: done.nonConformance!.id },
    });
    expect([nc.severity, nc.source, nc.branchId]).toEqual(["MEDIUM", "MOCK_RECALL", branchId]);
    expect(nc.description).toContain("found 90 against a book of 95");
    expect(nc.description).toContain("against a target of 60 min");
  });

  it("a lot without a known origin is flagged; drills can be cancelled with a reason", async () => {
    const drill = await startMockRecall(ctx, {
      branchId,
      lotId: opening,
      scenario: "Old stock check",
    });
    const view = await getMockRecall(ctx, drill.id);
    expect([view.gapCount, view.supplierCount, view.targetMinutes]).toEqual([1, 0, null]);
    const done = await completeMockRecall(ctx, drill.id, {
      counts: [{ id: view.counts[0].id, foundQuantity: "8" }],
    });
    expect(done.problems).toEqual(["TRACE_GAPS", "ORIGIN_UNKNOWN"]);
    expect(done.withinTarget).toBeNull();

    const other = await startMockRecall(ctx, { branchId, lotId: opening, scenario: "Dup" });
    await expectAppError(cancelMockRecall(ctx, other.id, { note: "" }), "VALIDATION_FAILED");
    await cancelMockRecall(ctx, other.id, { note: "Started by mistake" });
    await expectRule(cancelMockRecall(ctx, other.id, { note: "x" }), "MOCK_RECALL_FINISHED");
    expect((await listMockRecalls(ctx)).map((d) => d.status)).toContain("CANCELLED");
  });

  it("checks input, permissions and tenancy", async () => {
    await expectAppError(
      startMockRecall(ctx, { branchId, lotId: delivered, scenario: "x", targetMinutes: "0" }),
      "VALIDATION_FAILED",
    );
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(
      startMockRecall(cashier.ctx, { branchId, lotId: delivered, scenario: "x" }),
      "FORBIDDEN",
    );
    await expectAppError(listMockRecalls(cashier.ctx), "FORBIDDEN");
    const { ctx: other } = await createTenant("mock-recall-other");
    const otherBranch = (await createBranch(other, { code: "X", name: "X", type: "RESTAURANT" }))
      .id;
    await expectAppError(
      startMockRecall(other, { branchId: otherBranch, lotId: delivered, scenario: "x" }),
      "NOT_FOUND",
    );
    const mine = (await listMockRecalls(ctx))[0];
    await expectAppError(getMockRecall(other, mine.id), "NOT_FOUND");
  });
});
