import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { createTenant, expectAppError } from "../../../test/support/factories";
import { savePaymentProvider } from "@/modules/payments/links";
import type { Fetch } from "@/modules/payments/moyasar";
import { bumpTicket, createStation, stationBoard } from "./kitchen";
import {
  acceptGuestOrder,
  archiveOrderingChannel,
  createOrderingChannel,
  guestOrderStatus,
  listGuestOrders,
  markGuestPickedUp,
  markGuestReady,
  placeGuestOrder,
  publicMenu,
  rejectGuestOrder,
} from "./ordering";
import { archivePromotion, createPromotion } from "./promotions";
import { createRegister, openShift } from "./service";
import { createFloor, getTab, payTab } from "./tables";

/** Online ordering and kiosks (ADR-070). */

let ctx: TenantContext;
let other: TenantContext;
let branchId: string;
let register: string;
let station: string;
let cola: string;
let web: { id: string; publicToken: string };
let kiosk: { id: string; publicToken: string };

const order = (over: Record<string, unknown> = {}) => ({
  key: randomUUID(),
  channel: "TAKEAWAY",
  name: "Sara",
  phone: "0501234567",
  lines: [{ itemId: cola, quantity: 2 }],
  ...over,
});

beforeAll(async () => {
  ({ ctx } = await createTenant("ordering", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  ({ ctx: other } = await createTenant("ordering-other"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" })).id;
  const kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const can = (
    await createProduct(ctx, {
      sku: "COLA",
      nameEn: "Cola",
      type: "FINISHED_GOOD",
      baseUomId: units.each,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: kitchen,
    productId: can,
    quantity: "50",
    uomId: units.each,
    unitCost: "2",
  });
  const menu = (await createMenuCategory(ctx, { name: "Drinks" })).id;
  cola = (
    await createMenuItem(ctx, {
      code: "COLA",
      name: "Cola",
      categoryId: menu,
      kind: "ITEM",
      productId: can,
    })
  ).id;
  const today = businessDate("Asia/Riyadh");
  for (const channel of ["TAKEAWAY", "DINE_IN"])
    await addMenuItemPrice(ctx, cola, { channel, price: "10", effectiveFrom: today });
  register = (
    await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL1", name: "Till" })
  ).id;
  await openShift(ctx, register, { openingFloat: "0" });
  station = (
    await createStation(ctx, {
      branchId,
      code: "PASS",
      name: "Pass",
      targetMinutes: "10",
      isDefault: "on",
    })
  ).id;
}, 60_000); // two organizations and a menu: slower on a cold database

afterAll(async () => {
  await getDb().$disconnect();
});

describe("ordering channels (ADR-070)", () => {
  it("needs a floor at the branch and takes no dine-in on the web", async () => {
    await expectAppError(
      createOrderingChannel(ctx, { kind: "WEB", name: "Web", branchId, channels: ["TAKEAWAY"] }),
      "BUSINESS_RULE_VIOLATION",
    );
    await createFloor(ctx, {
      branchId,
      warehouseId: (
        await getDb().warehouse.findFirstOrThrow({ where: { organizationId: ctx.organizationId } })
      ).id,
      name: "Main",
    });
    await expectAppError(
      createOrderingChannel(ctx, { kind: "WEB", name: "Web", branchId, channels: ["DINE_IN"] }),
      "VALIDATION_FAILED",
    );
    web = await createOrderingChannel(ctx, {
      kind: "WEB",
      name: "Pick-up online",
      branchId,
      channels: ["TAKEAWAY"],
      maxOrderTotal: "100",
    });
    kiosk = await createOrderingChannel(ctx, {
      kind: "KIOSK",
      name: "Kiosk 1",
      branchId,
      channels: ["DINE_IN", "TAKEAWAY"],
      autoSend: "on",
    });
    expect(web.publicToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("shows guests the menu of the channels the page takes, with server prices", async () => {
    const m = (await publicMenu(web.publicToken))!;
    expect(m.channels.map((c) => c.channel)).toEqual(["TAKEAWAY"]);
    expect(m.channels[0].items[0]).toMatchObject({ name: "Cola", price: "10" });
    expect(await publicMenu("x".repeat(32))).toBeNull();
  });
});

describe("guest orders", () => {
  it("become a check the branch accepts; the guest follows it to collection", async () => {
    const placed = await placeGuestOrder(web.publicToken, order(), "10.0.0.1");
    expect(placed.duplicate).toBe(false);
    expect((await guestOrderStatus(placed.guestToken))!.state).toBe("RECEIVED");
    const listed = await listGuestOrders(ctx);
    expect(listed.find((o) => o.id === placed.id)).toMatchObject({
      state: "RECEIVED",
      guestName: "Sara",
      guestPhone: "+966501234567",
      source: "WEB",
    });
    // A resend with the same key returns the same order.
    const key = randomUUID();
    const a = await placeGuestOrder(web.publicToken, order({ key }), "10.0.0.2");
    const b = await placeGuestOrder(web.publicToken, order({ key }), "10.0.0.2");
    expect(b).toMatchObject({ id: a.id, duplicate: true });
    await rejectGuestOrder(ctx, a.id, { reason: "Closing early" });
    expect(await guestOrderStatus(a.guestToken)).toMatchObject({
      state: "CANCELLED",
      cancelReason: "Closing early",
    });

    await acceptGuestOrder(ctx, placed.id);
    expect((await guestOrderStatus(placed.guestToken))!.state).toBe("PREPARING");
    const board = await stationBoard(ctx, station);
    const ticket = board.tickets.find((t) => t.label.includes("Sara"))!;
    await bumpTicket(ctx, ticket.id);
    expect((await guestOrderStatus(placed.guestToken))!.state).toBe("READY");
    // Paid at the counter like any check; the phone is not kept after.
    await payTab(ctx, placed.id, {
      orderId: randomUUID(),
      registerId: register,
      payments: [{ method: "CASH", amount: "20" }],
      expectedTotal: "20",
    });
    expect((await guestOrderStatus(placed.guestToken))!.state).toBe("COLLECTED");
    const row = await getDb().posTab.findUniqueOrThrow({ where: { id: placed.id } });
    expect(row.guestPhone).toBeNull();
    expect((await getTab(ctx, placed.id)).channel).toBe("TAKEAWAY");
  });

  it("sends kiosk orders to the kitchen at once, without a phone", async () => {
    const placed = await placeGuestOrder(
      kiosk.publicToken,
      order({ channel: "DINE_IN", phone: "" }),
      "10.0.0.3",
    );
    expect((await guestOrderStatus(placed.guestToken))!.state).toBe("PREPARING");
  });

  it("refuses what a page does not take", async () => {
    await expectAppError(
      placeGuestOrder(web.publicToken, order({ phone: "" }), "10.0.0.4"),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      placeGuestOrder(web.publicToken, order({ channel: "DINE_IN" }), "10.0.0.4"),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      placeGuestOrder(
        web.publicToken,
        order({ lines: [{ itemId: cola, quantity: 11 }] }),
        "10.0.0.4",
      ),
      "BUSINESS_RULE_VIOLATION",
    ); // 110 > 100
    await expectAppError(
      placeGuestOrder(
        web.publicToken,
        order({ lines: [{ itemId: randomUUID(), quantity: 1 }] }),
        "10.0.0.4",
      ),
      "BUSINESS_RULE_VIOLATION",
    );
    // Nothing was left behind by the refused orders.
    expect(
      await getDb().posTab.count({
        where: { organizationId: ctx.organizationId, sourceChannelId: web.id, status: "OPEN" },
      }),
    ).toBe(0);
  });

  it("limits how often one address can order", async () => {
    const ip = "10.0.0.9";
    for (let i = 0; i < 5; i++) await placeGuestOrder(web.publicToken, order(), ip);
    await expectAppError(placeGuestOrder(web.publicToken, order(), ip), "BUSINESS_RULE_VIOLATION");
  });

  it("closes an archived page and keeps orders to their organization", async () => {
    const mine = (await listGuestOrders(ctx))[0];
    expect(await listGuestOrders(other)).toHaveLength(0);
    await expectAppError(acceptGuestOrder(other, mine.id), "NOT_FOUND");
    await expectAppError(archiveOrderingChannel(other, web.id), "NOT_FOUND");
    await archiveOrderingChannel(ctx, web.id);
    expect(await publicMenu(web.publicToken)).toBeNull();
    await expectAppError(placeGuestOrder(web.publicToken, order(), "10.0.0.5"), "NOT_FOUND");
  });
});

/**
 * SIMULATED MOYASAR (ADR-071): the gateway is not reachable from the
 * development environment; these tests check this application's flow.
 */
const invoices = new Map<string, { amount: number; status: string; payments: unknown[] }>();
const created: Array<Record<string, unknown>> = [];
let nextInvoice = 0;
const moyasar: Fetch = async (url, init) => {
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (url.endsWith("/invoices") && init.method === "POST") {
    const id = `inv-${++nextInvoice}`;
    created.push(body!);
    invoices.set(id, { amount: Number(body!.amount), status: "initiated", payments: [] });
    return json(201, {
      id,
      status: "initiated",
      amount: body!.amount,
      url: `https://checkout.moyasar.com/invoices/${id}`,
    });
  }
  const cancel = /\/invoices\/(.+)\/cancel$/.exec(url);
  if (cancel && invoices.has(cancel[1])) {
    invoices.get(cancel[1])!.status = "canceled";
    return json(200, { id: cancel[1], ...invoices.get(cancel[1]) });
  }
  const m = /\/invoices\/([^/]+)$/.exec(url);
  if (m && invoices.has(m[1])) return json(200, { id: m[1], ...invoices.get(m[1]) });
  return json(404, {});
};
const payInvoice = (n: number, amount?: number) => {
  const inv = invoices.get(`inv-${n}`)!;
  inv.status = "paid";
  if (amount) inv.amount = amount;
  inv.payments = [
    { id: `pay-${n}`, status: "paid", source: { company: "mada", number: "4464-04XX-XXXX-1234" } },
  ];
};

describe("online payment, pick-up times, ready and hand-over (ADR-071)", () => {
  let online: { id: string; publicToken: string };
  let later: { id: string; publicToken: string };

  it("takes payment online before the kitchen starts, confirmed with the provider", async () => {
    await savePaymentProvider(ctx, { mode: "TEST", secretKey: "sk_test_abcdefghij" });
    await expectAppError(
      createOrderingChannel(ctx, {
        kind: "WEB",
        name: "Pay",
        branchId,
        channels: ["TAKEAWAY"],
        paymentMode: "ONLINE",
      }),
      "VALIDATION_FAILED",
    ); // needs the register its payments are recorded on
    online = await createOrderingChannel(ctx, {
      kind: "WEB",
      name: "Pay online",
      branchId,
      channels: ["TAKEAWAY"],
      paymentMode: "ONLINE",
      registerId: register,
      autoSend: "on",
    });
    const placed = await placeGuestOrder(online.publicToken, order(), "10.1.0.1", moyasar);
    expect(placed.paymentUrl).toMatch(/^https:\/\/checkout\.moyasar\.com\//);
    // The guest returns to their status page; the invoice expires with the order.
    expect(created.at(-1)).toMatchObject({
      amount: 2000,
      callback_url: expect.stringContaining(`/order/status/${placed.guestToken}`),
    });
    expect(Date.parse(String(created.at(-1)!.expired_at)) - Date.now()).toBeGreaterThan(
      25 * 60_000,
    );

    // Not paid: waiting, nothing in the kitchen, the branch cannot start it.
    expect(await guestOrderStatus(placed.guestToken, moyasar)).toMatchObject({
      state: "AWAITING_PAYMENT",
      paymentUrl: placed.paymentUrl,
    });
    expect((await listGuestOrders(ctx, moyasar)).find((o) => o.id === placed.id)?.state).toBe(
      "AWAITING_PAYMENT",
    );
    await expectAppError(acceptGuestOrder(ctx, placed.id), "BUSINESS_RULE_VIOLATION");

    // Paid at Moyasar: recorded as a card payment, sent to the kitchen (auto-send).
    payInvoice(nextInvoice);
    expect((await guestOrderStatus(placed.guestToken, moyasar))!.state).toBe("PREPARING");
    const tab = await getDb().posTab.findUniqueOrThrow({
      where: { id: placed.id },
      include: { orders: { include: { payments: true } } },
    });
    expect(tab.status).toBe("CLOSED");
    expect(tab.orders[0].payments[0]).toMatchObject({
      method: "CARD",
      cardScheme: "MADA",
      cardLast4: "1234",
    });
    expect((await stationBoard(ctx, station)).tickets.some((t) => t.tabId === placed.id)).toBe(
      true,
    );
    await expectAppError(
      rejectGuestOrder(ctx, placed.id, { reason: "x" }),
      "BUSINESS_RULE_VIOLATION",
    );

    // Without kitchen screens, staff mark it ready and handed over.
    await markGuestReady(ctx, placed.id);
    expect((await guestOrderStatus(placed.guestToken, moyasar))!.state).toBe("READY");
    await markGuestPickedUp(ctx, placed.id);
    expect((await guestOrderStatus(placed.guestToken, moyasar))!.state).toBe("COLLECTED");
    expect((await listGuestOrders(ctx, moyasar)).some((o) => o.id === placed.id)).toBe(false);
  });

  it("cancels an order not paid in time, but never one paid at the provider", async () => {
    const unpaid = await placeGuestOrder(online.publicToken, order(), "10.1.0.2", moyasar);
    const odd = await placeGuestOrder(online.publicToken, order(), "10.1.0.3", moyasar);
    payInvoice(nextInvoice, 1); // paid, but another amount: kept for a person
    await getDb().posTab.updateMany({
      where: { id: { in: [unpaid.id, odd.id] } },
      data: { openedAt: new Date(Date.now() - 31 * 60_000) },
    });
    expect(await guestOrderStatus(unpaid.guestToken, moyasar)).toMatchObject({
      state: "CANCELLED",
      cancelReason: "Not paid in time",
    });
    // Its link is closed here; Moyasar's own expiry (expired_at) stops it being paid there.
    const link = await getDb().paymentLink.findFirstOrThrow({
      where: { tabId: unpaid.id },
    });
    expect(link.status).toBe("CANCELLED");
    expect((await guestOrderStatus(odd.guestToken, moyasar))!.state).toBe("AWAITING_PAYMENT");
    const listed = (await listGuestOrders(ctx, moyasar)).find((o) => o.id === odd.id)!;
    expect(listed.paymentProblem).toBe("PAYMENT_AMOUNT_DIFFERS");
  });

  it("offers pick-up slots, holds accepted orders and releases them in time", async () => {
    later = await createOrderingChannel(ctx, {
      kind: "WEB",
      name: "Pick-up later",
      branchId,
      channels: ["TAKEAWAY"],
      scheduling: "on",
      openFrom: "00:00",
      openTo: "00:00",
      slotMinutes: "15",
      leadMinutes: "20",
      // Tomorrow too, so there are enough slots whatever the hour the tests run.
      daysAhead: "1",
    });
    const menu = (await publicMenu(later.publicToken))!;
    expect(menu.asap).toBe(true);
    expect(menu.slots.length).toBeGreaterThan(8);
    await expectAppError(
      placeGuestOrder(
        later.publicToken,
        order({ pickupAt: new Date(Date.parse(menu.slots[4]) + 60_000).toISOString() }),
        "10.1.0.4",
      ),
      "BUSINESS_RULE_VIOLATION",
    ); // not a slot
    const placed = await placeGuestOrder(
      later.publicToken,
      order({ pickupAt: menu.slots[8] }),
      "10.1.0.4",
    );
    await expectAppError(markGuestReady(ctx, placed.id), "BUSINESS_RULE_VIOLATION"); // not accepted
    expect((await acceptGuestOrder(ctx, placed.id)).held).toBe(true);
    expect((await guestOrderStatus(placed.guestToken))!.state).toBe("SCHEDULED");
    expect((await stationBoard(ctx, station)).tickets.some((t) => t.tabId === placed.id)).toBe(
      false,
    );
    // Its lead time arrives: the staff list releases it to the kitchen.
    await getDb().posTab.update({
      where: { id: placed.id },
      data: { pickupAt: new Date(Date.now() + 10 * 60_000) },
    });
    expect((await listGuestOrders(ctx)).find((o) => o.id === placed.id)?.state).toBe("PREPARING");
    expect((await stationBoard(ctx, station)).tickets.some((t) => t.tabId === placed.id)).toBe(
      true,
    );
    // Paid at the counter on collection: collected.
    await markGuestReady(ctx, placed.id);
    await payTab(ctx, placed.id, {
      orderId: randomUUID(),
      registerId: register,
      payments: [{ method: "CASH", amount: "20" }],
      expectedTotal: "20",
    });
    expect((await guestOrderStatus(placed.guestToken))!.state).toBe("COLLECTED");
  });

  it("offers a slot only while the kitchen has room for it", async () => {
    const small = await createOrderingChannel(ctx, {
      kind: "WEB",
      name: "One per slot",
      branchId,
      channels: ["TAKEAWAY"],
      scheduling: "on",
      openFrom: "00:00",
      openTo: "00:00",
      slotMinutes: "30",
      leadMinutes: "20",
      slotCapacity: "1",
    });
    const slot = (await publicMenu(small.publicToken))!.slots[3];
    await placeGuestOrder(small.publicToken, order({ pickupAt: slot }), "10.1.0.6");
    expect((await publicMenu(small.publicToken))!.slots).not.toContain(slot);
    await expectAppError(
      placeGuestOrder(small.publicToken, order({ pickupAt: slot }), "10.1.0.7"),
      "BUSINESS_RULE_VIOLATION",
    );
    expect(
      await getDb().posTab.count({ where: { sourceChannelId: small.id, status: "OPEN" } }),
    ).toBe(1);
  });

  it("shows guests the promotions the counter will apply", async () => {
    const drinks = (await getDb().menuItem.findUniqueOrThrow({ where: { id: cola } })).categoryId;
    const p = await createPromotion(ctx, {
      name: "Half price drinks",
      percent: "50",
      categoryIds: [drinks],
      validFrom: businessDate("Asia/Riyadh"),
    });
    const menu = (await publicMenu(later.publicToken))!;
    expect(menu.promotions.map((x) => [x.name, x.percent])).toEqual([["Half price drinks", "50"]]);
    const placed = await placeGuestOrder(later.publicToken, order(), "10.1.0.5");
    await acceptGuestOrder(ctx, placed.id);
    // 2 × 10, half price: the counter charges 10, as the guest saw.
    await payTab(ctx, placed.id, {
      orderId: randomUUID(),
      registerId: register,
      payments: [{ method: "CASH", amount: "10" }],
      expectedTotal: "10",
    });
    await archivePromotion(ctx, p.id);
  });
});
