import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateApprovalMatrix } from "@/modules/approvals/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addOrderLine,
  approveOrder,
  closeOrder,
  createOrder,
  getOrder,
  removeOrderLine,
  reviseOrder,
  submitOrder,
  updateOrderHeader,
  updateOrderLine,
} from "./orders";
import { postReceipt } from "./receipts";
import { createSupplier } from "./suppliers";

/** Purchase order revisions (ADR-093). */

let ctx: TenantContext; // owner
let buyer: TenantContext;
let finance: TenantContext;
let analyst: TenantContext;
let warehouseId: string;
let supplierId: string;
let otherSupplier: string;
const products: Record<string, string> = {};
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

/** Approved order: 10 kg flour at 100, 5 l oil at 20. */
async function approvedOrder() {
  const { id } = await createOrder(buyer, { supplierId, warehouseId, expectedOn: "2026-12-01" });
  await addOrderLine(buyer, id, {
    productId: products.flour,
    uomId: units.kg,
    quantity: "10",
    unitPrice: "100",
  });
  await addOrderLine(buyer, id, {
    productId: products.oil,
    uomId: units.l,
    quantity: "5",
    unitPrice: "20",
  });
  expect((await submitOrder(buyer, id)).status).toBe("APPROVED");
  return getOrder(buyer, id);
}

const lineFor = (order: Awaited<ReturnType<typeof getOrder>>, productId: string) =>
  order.lines.find((l) => l.productId === productId)!;
const edit = (productId: string, uom: string, quantity: string, unitPrice: string) => ({
  productId,
  uomId: units[uom],
  quantity,
  unitPrice,
});

beforeAll(async () => {
  ({ ctx } = await createTenant("revisions"));
  buyer = (await addMember(ctx, "procurement")).ctx;
  finance = (await addMember(ctx, "finance")).ctx;
  analyst = (await addMember(ctx, "analyst")).ctx;
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  warehouseId = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" }))
    .id;
  for (const [key, sku, uom] of [
    ["flour", "FLOUR", "kg"],
    ["oil", "OIL", "l"],
    ["sugar", "SUGAR", "kg"],
  ] as const)
    products[key] = (
      await createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId: units[uom] })
    ).id;
  supplierId = (await createSupplier(ctx, { code: "NILE", name: "Nile" })).id;
  otherSupplier = (await createSupplier(ctx, { code: "DELTA", name: "Delta" })).id;
});

afterAll(async () => {
  await updateApprovalMatrix(ctx, "PURCHASE_ORDER", {});
});

describe("revising an approved order (ADR-093)", () => {
  it("keeps the version, protects received goods, and returns to its receipt status", async () => {
    const order = await approvedOrder();
    const flour = lineFor(order, products.flour);
    const oil = lineFor(order, products.oil);
    await postReceipt(buyer, order.id, {
      lines: [{ purchaseOrderLineId: flour.id, receivedQuantity: "6", unitPrice: "100" }],
    });

    await expectAppError(reviseOrder(buyer, order.id, { reason: "" }), "VALIDATION_FAILED");
    await expectAppError(reviseOrder(analyst, order.id, { reason: "x" }), "FORBIDDEN");
    expect(await reviseOrder(buyer, order.id, { reason: "Supplier short on flour" })).toEqual({
      revision: 1,
    });
    let now = await getOrder(buyer, order.id);
    expect(now.status).toBe("DRAFT");
    expect(now.underRevision).toBe(true);
    expect(now.can.receive).toBe(false);
    await expectRule(
      postReceipt(buyer, order.id, {
        lines: [{ purchaseOrderLineId: oil.id, receivedQuantity: "1", unitPrice: "20" }],
      }),
      "ORDER_NOT_RECEIVABLE",
    );

    // What was received stays as it was.
    await expectRule(removeOrderLine(buyer, order.id, flour.id), "RECEIVED_LINE_REMOVED");
    await expectRule(
      updateOrderLine(buyer, order.id, flour.id, edit(products.flour, "kg", "8", "95")),
      "RECEIVED_LINE_PRICE",
    );
    await expectRule(
      updateOrderLine(buyer, order.id, flour.id, edit(products.flour, "g", "8000", "0.1")),
      "RECEIVED_LINE_CHANGED",
    );
    await expectRule(
      updateOrderLine(buyer, order.id, flour.id, edit(products.flour, "kg", "5", "100")),
      "BELOW_RECEIVED",
    );
    await expectRule(
      updateOrderHeader(buyer, order.id, { supplierId: otherSupplier, warehouseId }),
      "REVISION_HEADER_FIXED",
    );
    // Allowed: less flour, dearer oil, a new line, a later date.
    await updateOrderLine(buyer, order.id, flour.id, edit(products.flour, "kg", "8", "100"));
    await updateOrderLine(buyer, order.id, oil.id, edit(products.oil, "l", "5", "22"));
    await addOrderLine(buyer, order.id, edit(products.sugar, "kg", "3", "30"));
    await updateOrderHeader(buyer, order.id, {
      supplierId,
      warehouseId,
      expectedOn: "2026-12-05",
    });

    expect((await submitOrder(buyer, order.id)).status).toBe("PARTIALLY_RECEIVED");
    now = await getOrder(analyst, order.id);
    expect(now.revision).toBe(1);
    expect(now.underRevision).toBe(false);
    expect(now.totalAmount.toFixed()).toBe("1000"); // 800 + 110 + 90
    expect(now.revisions).toHaveLength(1);
    const [r] = now.revisions;
    expect(r.reason).toBe("Supplier short on flour");
    expect(r.totalAmount.toFixed()).toBe("1100");
    expect(r.expectedOn).toEqual({ from: "2026-12-01", to: "2026-12-05" });
    expect(r.changes).toEqual([
      {
        kind: "CHANGED",
        productId: products.flour,
        quantity: { from: "10", to: "8" },
        unitPrice: null,
        uomChanged: false,
      },
      {
        kind: "CHANGED",
        productId: products.oil,
        quantity: null,
        unitPrice: { from: "20", to: "22" },
        uomChanged: false,
      },
      { kind: "ADDED", productId: products.sugar, quantity: "3", unitPrice: "30" },
    ]);

    // The database holds the same rules.
    await expect(
      getDb().purchaseOrderLine.update({ where: { id: flour.id }, data: { unitPrice: "1" } }),
    ).rejects.toThrow(/keeps its product, unit and price/);
    await expect(getDb().purchaseOrderLine.delete({ where: { id: flour.id } })).rejects.toThrow(
      /cannot be removed/,
    );
    await expect(
      getDb().purchaseOrder.update({ where: { id: order.id }, data: { revision: 3 } }),
    ).rejects.toThrow(/one version at a time/);
    await expect(
      getDb().purchaseOrderRevision.create({
        data: {
          organizationId: ctx.organizationId,
          purchaseOrderId: order.id,
          revision: 0,
          reason: "x",
          snapshot: { lines: [] },
          createdByUserId: ctx.userId,
        },
      }),
    ).rejects.toThrow();
  });

  it("goes through the approval matrix again", async () => {
    const order = await approvedOrder();
    await updateApprovalMatrix(ctx, "PURCHASE_ORDER", { layer4: "0" });
    await reviseOrder(buyer, order.id, { reason: "Price increase" });
    const oil = lineFor(order, products.oil);
    await updateOrderLine(buyer, order.id, oil.id, edit(products.oil, "l", "5", "25"));
    expect((await submitOrder(buyer, order.id)).status).toBe("PENDING_APPROVAL");
    expect((await approveOrder(finance, order.id)).status).toBe("APPROVED");
    // And can be revised again.
    expect((await reviseOrder(buyer, order.id, { reason: "Date" })).revision).toBe(2);
    expect((await getOrder(buyer, order.id)).revisions.map((r) => r.revision)).toEqual([0, 1]);
    await updateApprovalMatrix(ctx, "PURCHASE_ORDER", {});
  });

  it("can cut an order down to what was received, or close the revision", async () => {
    const order = await approvedOrder();
    const flour = lineFor(order, products.flour);
    const oil = lineFor(order, products.oil);
    await postReceipt(buyer, order.id, {
      lines: [
        { purchaseOrderLineId: flour.id, receivedQuantity: "4", unitPrice: "100" },
        { purchaseOrderLineId: oil.id, receivedQuantity: "5", unitPrice: "20" },
      ],
    });
    await reviseOrder(buyer, order.id, { reason: "No more flour this season" });
    await updateOrderLine(buyer, order.id, flour.id, edit(products.flour, "kg", "4", "100"));
    expect((await submitOrder(buyer, order.id)).status).toBe("RECEIVED");

    const second = await approvedOrder();
    await postReceipt(buyer, second.id, {
      lines: [
        {
          purchaseOrderLineId: lineFor(second, products.flour).id,
          receivedQuantity: "1",
          unitPrice: "100",
        },
      ],
    });
    await reviseOrder(buyer, second.id, { reason: "Re-plan" });
    expect((await getOrder(buyer, second.id)).can.close).toBe(true);
    await closeOrder(buyer, second.id, { reason: "Supplier closed" });
    expect((await getOrder(buyer, second.id)).status).toBe("CLOSED");
  });

  it("is only for approved orders, and invisible to other organizations", async () => {
    const { id } = await createOrder(buyer, { supplierId, warehouseId });
    await expectRule(reviseOrder(buyer, id, { reason: "x" }), "ORDER_STATUS");
    const order = await approvedOrder();
    const { ctx: other } = await createTenant("revisions-other");
    await expectAppError(reviseOrder(other, order.id, { reason: "x" }), "NOT_FOUND");
  });
});
