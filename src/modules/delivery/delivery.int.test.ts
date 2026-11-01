import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { sign } from "@/modules/integrations/crypto";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import {
  addMenuItemPrice,
  addModifierOption,
  attachModifierGroup,
  createMenuCategory,
  createMenuItem,
  createModifierGroup,
} from "@/modules/menu/service";
import { createStation } from "@/modules/pos/kitchen";
import { createRegister, getOrder, getShift, openShift, submitOrder } from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { createTenant, expectAppError } from "../../../test/support/factories";
import {
  acceptDeliveryOrder,
  createDeliveryConnector,
  deliveryMaps,
  handleDeliveryInbound,
  listDeliveryOrders,
  rejectDeliveryOrder,
  setDeliveryMap,
} from "./service";

/** Delivery platform orders (ADR-069). Prices include 15 % VAT. */

let ctx: TenantContext;
let other: TenantContext;
let register: string;
let shiftId: string;
let fries: string;
let cola: string;
let noSalt: string;
let hs: { id: string; publicId: string; secret: string };

const TZ = "Asia/Riyadh";
const now = () => String(Math.floor(Date.now() / 1000));
function send(
  c: { publicId: string; secret: string },
  payload: unknown,
  idempotencyKey = `evt-${randomUUID()}`,
  signed = true,
) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const timestamp = now();
  return handleDeliveryInbound({
    publicId: c.publicId,
    body,
    headers: {
      timestamp,
      signature: signed ? sign(c.secret, timestamp, body) : null,
      idempotencyKey,
    },
  });
}
const placed = (id: string, over: Record<string, unknown> = {}) => ({
  event: "order.placed",
  order: {
    id,
    displayCode: `#${id.slice(-3)}`,
    placedAt: new Date().toISOString(),
    customerName: "Sara",
    items: [
      {
        externalId: "FRY",
        name: "Fries",
        quantity: 2,
        unitPrice: "20",
        modifiers: [{ externalId: "NOSALT", name: "No salt" }],
      },
      { externalId: "COLA", name: "Cola", quantity: 1, unitPrice: "10" },
    ],
    discount: "5",
    total: "45",
    ...over,
  },
});
const deliveryOrder = (id: string) => getDb().deliveryOrder.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  ({ ctx } = await createTenant("delivery", { baseCurrency: "SAR", timeZone: TZ }));
  ({ ctx: other } = await createTenant("delivery-other", { baseCurrency: "SAR", timeZone: TZ }));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  await applyCountryPreset(ctx, "SA");
  const codes = Object.fromEntries((await getTaxSetup(ctx)).codes.map((c) => [c.code, c.id]));
  await updateTaxSettings(ctx, {
    country: "SA",
    vatRegistered: "on",
    pricesIncludeTax: "on",
    vatNumber: "310122393500003",
    defaultSalesTaxCodeId: codes.STD,
    defaultPurchaseTaxCodeId: codes.STD,
  });
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  const kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const product = async (sku: string) => {
    const id = (
      await createProduct(ctx, { sku, nameEn: sku, type: "FINISHED_GOOD", baseUomId: units.each })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId: kitchen,
      productId: id,
      quantity: "100",
      uomId: units.each,
      unitCost: "2",
    });
    return id;
  };
  const today = businessDate(TZ);
  const menu = (await createMenuCategory(ctx, { name: "Menu" })).id;
  fries = (
    await createMenuItem(ctx, {
      code: "FRIES",
      name: "Fries",
      categoryId: menu,
      kind: "ITEM",
      productId: await product("FRIES"),
    })
  ).id;
  cola = (
    await createMenuItem(ctx, {
      code: "COLA",
      name: "Cola",
      categoryId: menu,
      kind: "ITEM",
      productId: await product("COLA"),
    })
  ).id;
  // Sold in the restaurant only: the platform's prices apply to its orders.
  await addMenuItemPrice(ctx, fries, { channel: "DINE_IN", price: "23", effectiveFrom: today });
  await addMenuItemPrice(ctx, cola, { channel: "DINE_IN", price: "11.5", effectiveFrom: today });
  const extras = (
    await createModifierGroup(ctx, { name: "Extras", minSelect: "0", maxSelect: "1" })
  ).id;
  await addModifierOption(ctx, extras, { name: "No salt", priceDelta: "0" });
  noSalt = (await getDb().modifierOption.findFirstOrThrow({ where: { groupId: extras } })).id;
  await attachModifierGroup(ctx, fries, { groupId: extras });
  register = (
    await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL1", name: "Till" })
  ).id;
  shiftId = (await openShift(ctx, register, { openingFloat: "0" })).id;
  await createStation(ctx, {
    branchId,
    code: "PASS",
    name: "Pass",
    targetMinutes: "10",
    isDefault: "on",
  });
  hs = await createDeliveryConnector(ctx, {
    name: "HungerStation Riyadh",
    platform: "HUNGERSTATION",
    registerId: register,
  });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("delivery orders (ADR-069)", () => {
  it("refuses unsigned requests and bodies that are not the canonical format", async () => {
    expect((await send(hs, placed("HS-0"), undefined, false)).status).toBe(401);
    expect((await send(hs, { event: "order.placed", order: {} })).status).toBe(400);
    expect((await send(hs, "not json")).status).toBe(400);
  });

  it("keeps an order with unmapped items until they are mapped, then accepts it", async () => {
    const r = await send(hs, placed("HS-1"));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("NEEDS_MAPPING");
    const id = String(r.body.deliveryOrderId);
    const stored = await deliveryOrder(id);
    expect(JSON.stringify(stored.payload)).not.toContain("Sara"); // the name is kept apart, nothing more
    expect(stored.customerName).toBe("Sara");
    const m = await deliveryMaps(ctx, hs.id);
    expect(m.missing.items.map((i) => i.externalId).sort()).toEqual(["COLA", "FRY"]);
    expect(m.missing.options.map((i) => i.externalId)).toEqual(["NOSALT"]);
    await expectAppError(acceptDeliveryOrder(ctx, id), "BUSINESS_RULE_VIOLATION");

    await setDeliveryMap(ctx, hs.id, { kind: "ITEM", externalId: "FRY", targetId: fries });
    await setDeliveryMap(ctx, hs.id, { kind: "ITEM", externalId: "COLA", targetId: cola });
    await setDeliveryMap(ctx, hs.id, { kind: "OPTION", externalId: "NOSALT", targetId: noSalt });
    expect((await deliveryOrder(id)).status).toBe("PENDING");

    const accepted = await acceptDeliveryOrder(ctx, id);
    const o = await getOrder(ctx, accepted.posOrderId);
    expect(o.channel).toBe("DELIVERY");
    // The platform's prices (20 + 20 + 10) less its restaurant-funded discount of 5.
    expect(o.grossAmount.toFixed(2)).toBe("45.00");
    expect(o.orderDiscount.toFixed(2)).toBe("5.00");
    expect(o.discountReason).toBe("HUNGERSTATION discount");
    expect(o.taxAmount.toFixed(2)).toBe("5.87");
    expect(o.payments.map((p) => [p.method, p.amount.toFixed(2), p.reference])).toEqual([
      ["DELIVERY_PLATFORM", "45.00", "hungerstation:HS-1"],
    ]);
    expect((o.lines[0].options as Array<{ name: string }>)[0].name).toBe("No salt");
    expect((await deliveryOrder(id)).status).toBe("ACCEPTED");
    // Accepting again changes nothing.
    expect((await acceptDeliveryOrder(ctx, id)).duplicate).toBe(true);
  });

  it("does not take the same platform order twice", async () => {
    const first = await send(hs, placed("HS-2"), "evt-same-0001");
    expect((await send(hs, placed("HS-2"), "evt-same-0001")).body.duplicate).toBe(true);
    const again = await send(hs, placed("HS-2"), "evt-other-0002");
    expect(again.body).toMatchObject({
      duplicate: true,
      deliveryOrderId: first.body.deliveryOrderId,
    });
  });

  it("refuses a total that does not match the items, keeping the reason", async () => {
    const r = await send(hs, placed("HS-3", { total: "60" }));
    const id = String(r.body.deliveryOrderId);
    await expectAppError(acceptDeliveryOrder(ctx, id), "BUSINESS_RULE_VIOLATION");
    expect((await deliveryOrder(id)).problem).toBe("DELIVERY_TOTAL_DIFFERS");
    await rejectDeliveryOrder(ctx, id, { reason: "Total differs" });
    expect((await deliveryOrder(id)).status).toBe("REJECTED");
    await expectAppError(acceptDeliveryOrder(ctx, id), "BUSINESS_RULE_VIOLATION");
  });

  it("accepts automatically when set, and voids an order the platform cancels", async () => {
    const auto = await createDeliveryConnector(ctx, {
      name: "Jahez Riyadh",
      platform: "JAHEZ",
      registerId: register,
      autoAccept: "on",
    });
    for (const [externalId, targetId] of [["J-COLA", cola]] as const)
      await setDeliveryMap(ctx, auto.id, { kind: "ITEM", externalId, targetId });
    const order = {
      event: "order.placed",
      order: {
        id: "J-77",
        placedAt: new Date().toISOString(),
        items: [{ externalId: "J-COLA", quantity: 3, unitPrice: "9" }],
        total: "27",
      },
    };
    const r = await send(auto, order);
    expect(r.body.status).toBe("ACCEPTED");
    const d = await deliveryOrder(String(r.body.deliveryOrderId));
    const tickets = await getDb().kitchenTicket.findMany({ where: { orderId: d.posOrderId! } });
    expect(tickets.map((t) => t.label)).toEqual(["JAHEZ J-77"]);

    const cancelled = await send(auto, {
      event: "order.cancelled",
      order: { id: "J-77", reason: "Rider" },
    });
    expect(cancelled.body.status).toBe("CANCELLED");
    expect((await getOrder(ctx, d.posOrderId!)).status).toBe("VOIDED");
    expect((await send(auto, { event: "order.cancelled", order: { id: "nope" } })).status).toBe(
      404,
    );

    // Platform money is shown apart in the shift: not cash, not card.
    const shift = await getShift(ctx, shiftId);
    expect(shift.totals.platforms.toFixed(2)).toBe("45.00");
    expect(shift.totals.expectedCash.toFixed(2)).toBe("0.00");
  });

  it("never lets a device record an order as paid by a platform", async () => {
    await expectAppError(
      submitOrder(ctx, {
        orderId: randomUUID(),
        registerId: register,
        channel: "DELIVERY",
        lines: [{ itemId: cola, quantity: "1" }],
        payments: [{ method: "DELIVERY_PLATFORM", amount: "11.5", reference: "x" }],
      }),
      "VALIDATION_FAILED",
    );
  });

  it("keeps delivery orders and mappings to their organization", async () => {
    const mine = (await listDeliveryOrders(ctx)).map((o) => o.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(await listDeliveryOrders(other)).toHaveLength(0);
    await expectAppError(acceptDeliveryOrder(other, mine[0]), "NOT_FOUND");
    await expectAppError(deliveryMaps(other, hs.id), "NOT_FOUND");
    await expectAppError(
      createDeliveryConnector(other, { name: "x", platform: "KEETA", registerId: register }),
      "NOT_FOUND",
    );
    await expectAppError(
      setDeliveryMap(ctx, hs.id, { kind: "ITEM", externalId: "X", targetId: randomUUID() }),
      "NOT_FOUND",
    );
  });
});
