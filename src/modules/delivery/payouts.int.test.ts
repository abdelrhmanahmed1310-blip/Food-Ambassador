import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { sign } from "@/modules/integrations/crypto";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createStation } from "@/modules/pos/kitchen";
import { createRegister, openShift } from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  confirmDeliveryPayout,
  deleteDeliveryPayout,
  getDeliveryPayout,
  importDeliveryPayout,
  listDeliveryPayouts,
} from "./payouts";
import {
  acceptDeliveryOrder,
  createDeliveryConnector,
  handleDeliveryInbound,
  setDeliveryMap,
} from "./service";

/** Delivery platform payouts (ADR-075). */

let ctx: TenantContext;
let other: TenantContext;
let finance: TenantContext;
let cashier: TenantContext;
const H = "order_id,description,gross,commission,fees,vat_on_fees,net\n";
const TZ = "Asia/Riyadh";

let connector: { id: string; publicId: string; secret: string };
async function send(payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const r = await handleDeliveryInbound({
    publicId: connector.publicId,
    body,
    headers: {
      timestamp,
      signature: sign(connector.secret, timestamp, body),
      idempotencyKey: randomUUID(),
    },
  });
  expect(r.status).toBe(200);
  return String(r.body.deliveryOrderId);
}
/** A platform order of `count` colas at 15 each, placed at `placedAt`; accepted unless cancelled first. */
async function order(externalId: string, count: number, placedAt: string, cancel = false) {
  const id = await send({
    event: "order.placed",
    order: {
      id: externalId,
      placedAt,
      items: [{ externalId: "COLA", name: "Cola", quantity: count, unitPrice: "15" }],
      total: String(15 * count),
    },
  });
  if (cancel) await send({ event: "order.cancelled", order: { id: externalId } });
  else await acceptDeliveryOrder(ctx, id);
}
const input = (reference: string, over: Record<string, string> = {}) => ({
  connectorId: connector.id,
  reference,
  periodFrom: "2026-10-01",
  periodTo: "2026-10-07",
  ...over,
});

beforeAll(async () => {
  ({ ctx } = await createTenant("payouts", { baseCurrency: "SAR", timeZone: TZ }));
  ({ ctx: other } = await createTenant("payouts-other", { baseCurrency: "SAR", timeZone: TZ }));
  ({ ctx: finance } = await addMember(ctx, "finance"));
  ({ ctx: cashier } = await addMember(ctx, "cashier"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  const kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const productId = (
    await createProduct(ctx, {
      sku: "COLA",
      nameEn: "Cola",
      type: "FINISHED_GOOD",
      baseUomId: units.each,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: kitchen,
    productId,
    quantity: "100",
    uomId: units.each,
    unitCost: "2",
  });
  const menu = (await createMenuCategory(ctx, { name: "Menu" })).id;
  const cola = (
    await createMenuItem(ctx, {
      code: "COLA",
      name: "Cola",
      categoryId: menu,
      kind: "ITEM",
      productId,
    })
  ).id;
  await addMenuItemPrice(ctx, cola, {
    channel: "DINE_IN",
    price: "15",
    effectiveFrom: businessDate(TZ),
  });
  const register = (
    await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL1", name: "Till" })
  ).id;
  await openShift(ctx, register, { openingFloat: "0" });
  await createStation(ctx, {
    branchId,
    code: "PASS",
    name: "Pass",
    targetMinutes: "10",
    isDefault: "on",
  });
  connector = await createDeliveryConnector(ctx, {
    name: "HungerStation",
    platform: "HUNGERSTATION",
    registerId: register,
  });
  await setDeliveryMap(ctx, connector.id, { kind: "ITEM", externalId: "COLA", targetId: cola });
  // Riyadh is UTC+3: 2026-10-07 23:30 local is 20:30 UTC, inside the period; 2026-10-08 00:30 local is not.
  await order("A1", 3, "2026-10-01T09:00:00Z"); // 45
  await order("A2", 2, "2026-10-02T09:00:00Z"); // 30
  await order("A3", 1, "2026-10-03T09:00:00Z", true); // cancelled
  await order("A4", 4, "2026-10-07T20:30:00Z"); // 60
  await order("A5", 1, "2026-10-07T21:30:00Z"); // 15, after the period
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("delivery payouts (ADR-075)", () => {
  let first: string;

  it("imports a statement, matching each line with the order received", async () => {
    const r = await importDeliveryPayout(finance, input("ST-1", { receivedAmount: "60" }), {
      fileName: "st-1.csv",
      text: `${H}A1,,45.00,9,0,1.35,34.65\nA2,,29.00,5.8,0,0.87,22.33\nA3,,20,4,0,0.6,15.4\nZ9,,10,2,0,0.3,7.7\n,Marketing,0,0,10,1.5,-11.5\n`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    first = r.payoutId;
    const v = await getDeliveryPayout(finance, first);
    expect(v.payout.lines.map((l) => [l.externalId, l.match])).toEqual([
      ["A1", "MATCHED"],
      ["A2", "AMOUNT_DIFFERS"],
      ["A3", "CANCELLED_ORDER"],
      ["Z9", "NOT_FOUND"],
      [null, "ADJUSTMENT"],
    ]);
    expect(v.payout.net.toFixed(2)).toBe("68.58");
    expect(v.payout.commission.toFixed(2)).toBe("20.80");
    expect(v.bankDifference!.toFixed(2)).toBe("-8.58");
    expect(v.exceptions).toBe(4);
    // A4 (late on the last local day) is unpaid; A5 is after the period in Riyadh time.
    expect(v.unpaid.map((o) => o.externalId)).toEqual(["A4"]);
    expect(v.unpaidTotal.toFixed(2)).toBe("60.00");
  });

  it("refuses a bad file without keeping anything, and the same statement twice", async () => {
    const bad = await importDeliveryPayout(finance, input("ST-BAD"), {
      text: `${H}A1,,45,9,0,1.35,1\n`,
    });
    expect(bad).toEqual({
      ok: false,
      errors: [{ row: 2, column: "net", message: "netDoesNotAddUp" }],
    });
    await expectAppError(
      importDeliveryPayout(finance, input("ST-1"), { text: `${H}A4,,60,12,0,1.8,46.2\n` }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await listDeliveryPayouts(finance)).map((p) => p.reference)).toEqual(["ST-1"]);
  });

  it("confirms: orders it pays are settled, and no other statement can pay them again", async () => {
    // A second draft also claims A1 before the first is confirmed.
    const second = await importDeliveryPayout(finance, input("ST-2"), {
      text: `${H}A1,,45,9,0,1.35,34.65\nA4,,60,12,0,1.8,46.2\n`,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((await confirmDeliveryPayout(finance, first)).settled).toBe(2);
    await expectAppError(confirmDeliveryPayout(finance, first), "BUSINESS_RULE_VIOLATION");
    await expectAppError(deleteDeliveryPayout(finance, first), "BUSINESS_RULE_VIOLATION");

    // Confirming the second matches again: A1 is now already paid; A4 settles.
    expect((await confirmDeliveryPayout(finance, second.payoutId)).settled).toBe(1);
    const v = await getDeliveryPayout(finance, second.payoutId);
    expect(v.payout.lines.map((l) => [l.externalId, l.match, l.settled])).toEqual([
      ["A1", "ALREADY_PAID", false],
      ["A4", "MATCHED", true],
    ]);
    expect((await getDeliveryPayout(finance, first)).unpaid).toEqual([]);
  });

  it("keeps confirmed statements fixed in the database", async () => {
    await expect(
      getDb().deliveryPayout.update({ where: { id: first }, data: { note: "changed" } }),
    ).rejects.toThrow(/fixed/);
    await expect(
      getDb().deliveryPayoutLine.updateMany({
        where: { payoutId: first },
        data: { settled: false },
      }),
    ).rejects.toThrow(/fixed/);
  });

  it("deletes a draft", async () => {
    const r = await importDeliveryPayout(finance, input("ST-3"), {
      text: `${H}A2,,30,6,0,0.9,23.1\n`,
    });
    if (!r.ok) throw new Error("import failed");
    await deleteDeliveryPayout(finance, r.payoutId);
    await expectAppError(getDeliveryPayout(finance, r.payoutId), "NOT_FOUND");
  });

  it("is for finance only, and other organizations see nothing", async () => {
    await expectAppError(listDeliveryPayouts(cashier), "FORBIDDEN");
    await expectAppError(
      importDeliveryPayout(cashier, input("ST-X"), { text: `${H}A2,,30,6,0,0.9,23.1\n` }),
      "FORBIDDEN",
    );
    await expectAppError(getDeliveryPayout(other, first), "NOT_FOUND");
    await expectAppError(confirmDeliveryPayout(other, first), "NOT_FOUND");
    expect(await listDeliveryPayouts(other)).toEqual([]);
    // Another organization cannot import against this organization's connector.
    await expectAppError(
      importDeliveryPayout(other, input("ST-Y"), { text: `${H}A2,,30,6,0,0.9,23.1\n` }),
      "NOT_FOUND",
    );
  });
});
