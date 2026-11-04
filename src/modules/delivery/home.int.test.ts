import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createRegister, openShift, submitOrder, voidOrder } from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  assignRider,
  cancelHomeDelivery,
  createHomeDelivery,
  dispatchBoard,
  markDelivered,
  markFailed,
  myDeliveries,
  pickUp,
  purgeDeliveryContacts,
} from "./home";

/** The restaurant's own delivery riders (ADR-117). */

let ctx: TenantContext;
let branchId: string;
let otherBranch: string;
let register: string;
let shiftId: string;
let item: string;
let rider: TenantContext;
let cashier: TenantContext;

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

async function sell(channel: "DELIVERY" | "TAKEAWAY") {
  const orderId = randomUUID();
  await submitOrder(ctx, {
    orderId,
    registerId: register,
    shiftId,
    channel,
    lines: [{ itemId: item, quantity: "2" }],
    payments: [{ method: "CARD", amount: "50" }],
  });
  return orderId;
}

const contact = {
  contactName: "Sara",
  phone: "+966 50 123 4567",
  address: "12 Olaya St, Riyadh",
  directions: "Gate 3",
};

beforeAll(async () => {
  ({ ctx } = await createTenant("riders"));
  const today = businessDate(ctx.timeZone);
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  branchId = (await createBranch(ctx, { code: "OLY", name: "Olaya", type: "RESTAURANT" })).id;
  otherBranch = (await createBranch(ctx, { code: "MLZ", name: "Malaz", type: "RESTAURANT" })).id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "OLY-K", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const productId = (
    await createProduct(ctx, {
      sku: "WRAP",
      nameEn: "Wrap",
      type: "FINISHED_GOOD",
      baseUomId: each,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId,
    productId,
    quantity: "100",
    uomId: each,
    unitCost: "8",
  });
  const category = (await createMenuCategory(ctx, { name: "Menu" })).id;
  item = (
    await createMenuItem(ctx, {
      code: "WRAP",
      name: "Wrap",
      categoryId: category,
      kind: "ITEM",
      productId,
    })
  ).id;
  for (const channel of ["DELIVERY", "TAKEAWAY"] as const)
    await addMenuItemPrice(ctx, item, { channel, price: "25", effectiveFrom: today });
  register = (await createRegister(ctx, { branchId, warehouseId, code: "T1", name: "Till" })).id;
  shiftId = (await openShift(ctx, register, { openingFloat: "0" })).id;
  rider = (await addMember(ctx, "driver", { scopeType: "BRANCH", branchId })).ctx;
  cashier = (await addMember(ctx, "cashier", { scopeType: "BRANCH", branchId })).ctx;
}, 90_000);

describe("own delivery riders (ADR-117)", () => {
  it("dispatches a delivery order to a branch rider who delivers it", async () => {
    const orderId = await sell("DELIVERY");
    let board = await dispatchBoard(cashier, branchId);
    expect(board.ordersWithoutDelivery.map((o) => o.id)).toEqual([orderId]);
    expect(board.riders.map((r) => r.id)).toContain(rider.userId);

    await expectAppError(
      createHomeDelivery(cashier, { posOrderId: orderId, phone: "call me", address: "x" }),
      "VALIDATION_FAILED",
    );
    await expectRule(
      createHomeDelivery(cashier, { posOrderId: await sell("TAKEAWAY"), ...contact }),
      "NOT_A_DELIVERY_ORDER",
    );
    const d = await createHomeDelivery(cashier, { posOrderId: orderId, ...contact });
    await expectAppError(
      createHomeDelivery(cashier, { posOrderId: orderId, ...contact }),
      "CONFLICT",
    );

    // Only someone riding for the branch; the rider cannot pick up before being assigned.
    await expectRule(
      assignRider(cashier, d.id, { riderUserId: cashier.userId }),
      "RIDER_NOT_ALLOWED",
    );
    await expectAppError(pickUp(rider, d.id), "NOT_FOUND");
    await assignRider(cashier, d.id, { riderUserId: rider.userId });
    const mine = await myDeliveries(rider);
    expect(mine.map((x) => [x.posOrder.number, x.address, x.phone, x.status])).toEqual([
      [mine[0].posOrder.number, "12 Olaya St, Riyadh", "+966 50 123 4567", "ASSIGNED"],
    ]);
    expect(mine[0].mapUrl).toContain("12%20Olaya%20St");
    await expectRule(markDelivered(rider, d.id), "DELIVERY_NOT_OUT");
    await pickUp(rider, d.id);
    await expectRule(
      assignRider(cashier, d.id, { riderUserId: rider.userId }),
      "DELIVERY_ALREADY_LEFT",
    );
    await expectRule(cancelHomeDelivery(cashier, d.id, { reason: "x" }), "DELIVERY_ALREADY_LEFT");
    await markDelivered(rider, d.id, { recipientName: "Sara" });

    board = await dispatchBoard(cashier, branchId);
    const done = board.deliveries.find((x) => x.id === d.id)!;
    expect([done.status, done.recipientName, done.totalMinutes !== null]).toEqual([
      "DELIVERED",
      "Sara",
      true,
    ]);
    expect(board.riders.find((r) => r.id === rider.userId)?.stats).toMatchObject({
      delivered: 1,
      failed: 0,
    });
    // The audit trail keeps no address or phone.
    const logs = await getDb().auditEvent.findMany({
      where: { organizationId: ctx.organizationId, entityType: "home_delivery" },
    });
    expect(JSON.stringify(logs)).not.toContain("Olaya St");
  });

  it("records a failed delivery, and cancels one whose order was voided", async () => {
    const failed = await createHomeDelivery(cashier, {
      posOrderId: await sell("DELIVERY"),
      ...contact,
    });
    await assignRider(cashier, failed.id, { riderUserId: rider.userId });
    await pickUp(rider, failed.id);
    await expectAppError(markFailed(rider, failed.id, { reason: "" }), "VALIDATION_FAILED");
    await markFailed(rider, failed.id, { reason: "No answer at the door" });

    const orderId = await sell("DELIVERY");
    const voided = await createHomeDelivery(cashier, { posOrderId: orderId, ...contact });
    await assignRider(cashier, voided.id, { riderUserId: rider.userId });
    await voidOrder(ctx, orderId, { reason: "Customer cancelled" });
    await expectRule(pickUp(rider, voided.id), "ORDER_VOIDED");
    await cancelHomeDelivery(cashier, voided.id, { reason: "Order voided" });
    const board = await dispatchBoard(cashier, branchId);
    expect(board.deliveries.map((x) => x.status).sort()).toEqual([
      "CANCELLED",
      "DELIVERED",
      "FAILED",
    ]);
  });

  it("erases contact details 30 days after a delivery ends, and only then", async () => {
    const ended = await getDb().homeDelivery.findMany({
      where: { organizationId: ctx.organizationId },
    });
    expect((await purgeDeliveryContacts()).purged).toBe(0);
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect((await purgeDeliveryContacts({ now: later })).purged).toBeGreaterThanOrEqual(
      ended.length,
    );
    const after = await getDb().homeDelivery.findMany({
      where: { organizationId: ctx.organizationId },
    });
    expect(
      after.every((x) => x.address === null && x.phone === null && x.contactPurgedAt !== null),
    ).toBe(true);
    expect(after.find((x) => x.status === "DELIVERED")?.recipientName).toBe("Sara");
  });

  it("is dispatched at its branch only; riders see only their own", async () => {
    const elsewhere = (
      await addMember(ctx, "cashier", { scopeType: "BRANCH", branchId: otherBranch })
    ).ctx;
    await expectAppError(dispatchBoard(elsewhere, branchId), "NOT_FOUND");
    const orderId = await sell("DELIVERY");
    await expectAppError(
      createHomeDelivery(elsewhere, { posOrderId: orderId, ...contact }),
      "NOT_FOUND",
    );
    const otherRider = (await addMember(ctx, "driver", { scopeType: "BRANCH", branchId })).ctx;
    expect(await myDeliveries(otherRider)).toEqual([]);
    await expectAppError(myDeliveries(cashier), "FORBIDDEN");
    const { ctx: stranger } = await createTenant("riders-other");
    await expectAppError(dispatchBoard(stranger, branchId), "NOT_FOUND");
  });
});
