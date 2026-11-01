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
import { bumpTicket, createStation, stationBoard } from "./kitchen";
import {
  acceptGuestOrder,
  archiveOrderingChannel,
  createOrderingChannel,
  guestOrderStatus,
  listGuestOrders,
  placeGuestOrder,
  publicMenu,
  rejectGuestOrder,
} from "./ordering";
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
});

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
      state: "NEW",
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
