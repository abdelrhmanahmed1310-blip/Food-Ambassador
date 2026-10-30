import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { cancelOrder, getOrder, removeOrderLine } from "./orders";
import {
  addRequisitionLine,
  cancelRequisition,
  closeRequisition,
  createRequisition,
  getRequisition,
  listRequisitions,
  orderRequisition,
  rejectRequisition,
  removeRequisitionLine,
  submitRequisition,
} from "./requisitions";
import { createSupplier, saveSupplierProduct } from "./suppliers";

let ctx: TenantContext;
let units: Record<string, string>;
let kitchen: string; // branch A
let otherWh: string; // branch B
let branchA: string;
let branchB: string;
let supplierId: string;
let flour: string;
let sugar: string;
let requester: TenantContext;
let buyer: TenantContext;

beforeAll(async () => {
  ({ ctx } = await createTenant("requisitions"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  branchA = (await createBranch(ctx, { code: "ZAM", name: "Zamalek", type: "RESTAURANT" })).id;
  branchB = (await createBranch(ctx, { code: "MAA", name: "Maadi", type: "RESTAURANT" })).id;
  kitchen = (
    await createWarehouse(ctx, {
      branchId: branchA,
      code: "ZAM-K",
      name: "Kitchen",
      type: "KITCHEN_STORE",
    })
  ).id;
  otherWh = (
    await createWarehouse(ctx, {
      branchId: branchB,
      code: "MAA-K",
      name: "Kitchen",
      type: "KITCHEN_STORE",
    })
  ).id;
  const product = async (sku: string) =>
    (await createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId: units.kg })).id;
  flour = await product("FLOUR");
  sugar = await product("SUGAR");
  supplierId = (await createSupplier(ctx, { code: "MILLS", name: "Cairo Mills" })).id;
  await saveSupplierProduct(ctx, supplierId, {
    productId: flour,
    purchaseUomId: units.kg,
    lastUnitPrice: "12.5",
  });
  requester = (await addMember(ctx, "warehouse", { scopeType: "BRANCH", branchId: branchA })).ctx;
  buyer = (await addMember(ctx, "procurement")).ctx;
});

afterAll(async () => {
  await getDb().$disconnect();
});

async function submitted(lines: Array<[string, string]>) {
  const { id } = await createRequisition(requester, { warehouseId: kitchen, note: "Weekend" });
  for (const [productId, quantity] of lines)
    await addRequisitionLine(requester, id, { productId, quantity, uomId: units.kg });
  await submitRequisition(requester, id);
  return id;
}

describe("purchase requisitions", () => {
  it("lets a branch request goods and a buyer order them in steps", async () => {
    const { id, number } = await createRequisition(requester, {
      warehouseId: kitchen,
      neededBy: "2026-11-05",
    });
    expect(number).toMatch(/^REQ-\d{4}-\d{6}$/);
    await expectAppError(submitRequisition(requester, id), "BUSINESS_RULE_VIOLATION");
    await addRequisitionLine(requester, id, { productId: flour, quantity: "20", uomId: units.kg });
    await expectAppError(
      addRequisitionLine(requester, id, { productId: flour, quantity: "1", uomId: units.kg }),
      "CONFLICT",
    );
    await addRequisitionLine(requester, id, { productId: sugar, quantity: "5", uomId: units.g });
    let req = await getRequisition(requester, id);
    await removeRequisitionLine(requester, id, req.lines[1].id);
    await addRequisitionLine(requester, id, { productId: sugar, quantity: "5", uomId: units.kg });
    await submitRequisition(requester, id);
    await expectAppError(
      addRequisitionLine(requester, id, { productId: flour, quantity: "1", uomId: units.kg }),
      "BUSINESS_RULE_VIOLATION",
    );

    // The requester cannot order; the buyer sees the supplier's price in the same unit.
    req = await getRequisition(buyer, id, { supplierId });
    expect(req.can).toMatchObject({ order: true, reject: true, edit: false });
    expect(req.lines.map((l) => l.suggestedPrice)).toEqual(["12.5", null]);
    const [flourLine, sugarLine] = req.lines;
    await expectAppError(
      orderRequisition(requester, id, {
        supplierId,
        lines: [{ lineId: flourLine.id, include: "on", unitPrice: "12.5" }],
      }),
      "FORBIDDEN",
    );
    // A selected line needs a price; nothing selected is refused.
    await expectAppError(
      orderRequisition(buyer, id, { supplierId, lines: [{ lineId: flourLine.id, include: "on" }] }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      orderRequisition(buyer, id, { supplierId, lines: [{ lineId: flourLine.id }] }),
      "VALIDATION_FAILED",
    );

    const first = await orderRequisition(buyer, id, {
      supplierId,
      lines: [
        { lineId: flourLine.id, include: "on", unitPrice: "12.5" },
        { lineId: sugarLine.id, unitPrice: "" },
      ],
    });
    expect(first.status).toBe("PARTIALLY_ORDERED");
    const order = await getOrder(buyer, first.orderId);
    expect(order.status).toBe("DRAFT");
    expect(order.warehouseId).toBe(kitchen);
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].quantity.toFixed()).toBe("20");
    expect(order.totalAmount.toFixed()).toBe("250");
    await expectAppError(
      orderRequisition(buyer, id, {
        supplierId,
        lines: [{ lineId: flourLine.id, include: "on", unitPrice: "12.5" }],
      }),
      "BUSINESS_RULE_VIOLATION",
    );

    // Removing the order line frees the requisition line again.
    await removeOrderLine(buyer, first.orderId, order.lines[0].id);
    expect((await getRequisition(buyer, id)).status).toBe("SUBMITTED");

    const all = await orderRequisition(buyer, id, {
      supplierId,
      lines: [
        { lineId: flourLine.id, include: "on", unitPrice: "12" },
        { lineId: sugarLine.id, include: "on", unitPrice: "30" },
      ],
    });
    expect(all.status).toBe("ORDERED");
    req = await getRequisition(requester, id);
    expect(req.lines.every((l) => l.purchaseOrderLine?.purchaseOrder.id === all.orderId)).toBe(
      true,
    );
    expect(req.can).toEqual({
      edit: false,
      cancel: false,
      order: false,
      reject: false,
      close: false,
    });

    // Cancelling the order puts the request back in the buyer's queue.
    await cancelOrder(buyer, all.orderId, { reason: "Supplier closed" });
    expect((await getRequisition(buyer, id)).status).toBe("SUBMITTED");
  });

  it("rejects, closes and cancels with reasons only in the right state", async () => {
    const rejected = await submitted([[flour, "3"]]);
    await expectAppError(
      closeRequisition(buyer, rejected, { reason: "x" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(rejectRequisition(buyer, rejected, { reason: "" }), "VALIDATION_FAILED");
    await rejectRequisition(buyer, rejected, { reason: "Use the central kitchen stock" });
    const r = await getRequisition(requester, rejected);
    expect(r).toMatchObject({
      status: "REJECTED",
      decisionReason: "Use the central kitchen stock",
    });

    const partly = await submitted([
      [flour, "3"],
      [sugar, "2"],
    ]);
    const lines = (await getRequisition(buyer, partly)).lines;
    await orderRequisition(buyer, partly, {
      supplierId,
      lines: [{ lineId: lines[0].id, include: "on", unitPrice: "12" }],
    });
    await expectAppError(
      rejectRequisition(buyer, partly, { reason: "x" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      cancelRequisition(requester, partly, { reason: "x" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await closeRequisition(buyer, partly, { reason: "Sugar no longer needed" });
    expect((await getRequisition(buyer, partly)).status).toBe("CLOSED");

    const draft = await createRequisition(requester, { warehouseId: kitchen });
    await cancelRequisition(requester, draft.id, { reason: "Duplicate" });
    expect((await getRequisition(requester, draft.id)).status).toBe("CANCELLED");
  });

  it("keeps requisitions inside the branch and the organization", async () => {
    await expectAppError(createRequisition(requester, { warehouseId: otherWh }), "NOT_FOUND");
    // The finance role can see purchasing but may not request.
    const finance = (await addMember(ctx, "finance")).ctx;
    await expectAppError(createRequisition(finance, { warehouseId: kitchen }), "FORBIDDEN");

    const id = await submitted([[flour, "1"]]);
    const otherBranch = (
      await addMember(ctx, "warehouse", { scopeType: "BRANCH", branchId: branchB })
    ).ctx;
    await expectAppError(getRequisition(otherBranch, id), "NOT_FOUND");
    expect((await listRequisitions(otherBranch)).items.map((r) => r.id)).not.toContain(id);
    expect((await listRequisitions(requester)).items.map((r) => r.id)).toContain(id);
    expect(
      (await listRequisitions(buyer, { status: "SUBMITTED" })).items.map((r) => r.id),
    ).toContain(id);

    const other = await createTenant("requisitions-other");
    await expectAppError(getRequisition(other.ctx, id), "NOT_FOUND");
    await expectAppError(rejectRequisition(other.ctx, id, { reason: "x" }), "NOT_FOUND");
  });
});
