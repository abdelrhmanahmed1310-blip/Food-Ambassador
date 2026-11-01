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
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  bumpTicket,
  createStation,
  listStations,
  prepTimes,
  recallTicket,
  removeRoute,
  setRoute,
  stationBoard,
} from "./kitchen";
import { createRegister, getShift, openShift, submitOrder, voidOrder } from "./service";
import {
  addTabLines,
  createFloor,
  createTable,
  getTab,
  openTab,
  sendTab,
  voidTabLine,
} from "./tables";

let ctx: TenantContext;
let branchId: string;
let otherBranch: string;
let kitchen: string;
let mains: string;
let burger: string;
let cola: string;
let grill: string;
let bar: string;
let table: string;
let register: string;
let shiftId: string;

const ticketsOf = async (stationId: string) => (await stationBoard(ctx, stationId)).tickets;

beforeAll(async () => {
  ({ ctx } = await createTenant("kitchen"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  branchId = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  otherBranch = (await createBranch(ctx, { code: "ALX", name: "Alex", type: "RESTAURANT" })).id;
  kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const product = async (sku: string) =>
    (await createProduct(ctx, { sku, nameEn: sku, type: "FINISHED_GOOD", baseUomId: units.each }))
      .id;
  const patty = await product("PATTY");
  const can = await product("COLA");
  for (const p of [patty, can])
    await postOpeningBalance(ctx, {
      warehouseId: kitchen,
      productId: p,
      quantity: "50",
      uomId: units.each,
      unitCost: "5",
    });
  const today = businessDate(ctx.timeZone);
  mains = (await createMenuCategory(ctx, { name: "Mains" })).id;
  const drinks = (await createMenuCategory(ctx, { name: "Drinks" })).id;
  burger = (
    await createMenuItem(ctx, {
      code: "BURGER",
      name: "Burger",
      categoryId: mains,
      kind: "ITEM",
      productId: patty,
    })
  ).id;
  cola = (
    await createMenuItem(ctx, {
      code: "COLA",
      name: "Cola",
      categoryId: drinks,
      kind: "ITEM",
      productId: can,
    })
  ).id;
  for (const [i, price] of [
    [burger, "80"],
    [cola, "20"],
  ] as const)
    for (const channel of ["DINE_IN", "TAKEAWAY"])
      await addMenuItemPrice(ctx, i, { channel, price, effectiveFrom: today });
  const floor = (await createFloor(ctx, { branchId, warehouseId: kitchen, name: "Hall" })).id;
  table = (await createTable(ctx, floor, { code: "T1", seats: "4", gridX: "0", gridY: "0" })).id;
  register = (
    await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL", name: "Till" })
  ).id;
  shiftId = (await openShift(ctx, register, { openingFloat: "0" })).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("stations and routing (ADR-063)", () => {
  it("sets up stations with one default per branch and routes by category or item", async () => {
    grill = (
      await createStation(ctx, {
        branchId,
        code: "GRILL",
        name: "Grill",
        targetMinutes: "10",
        isDefault: "on",
      })
    ).id;
    bar = (await createStation(ctx, { branchId, code: "BAR", name: "Bar", targetMinutes: "3" })).id;
    await expectAppError(
      createStation(ctx, {
        branchId,
        code: "PASS",
        name: "Pass",
        targetMinutes: "5",
        isDefault: "on",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      createStation(ctx, { branchId, code: "grill", name: "x", targetMinutes: "5" }),
      "CONFLICT",
    );
    await setRoute(ctx, grill, { categoryId: mains });
    await setRoute(ctx, bar, { menuItemId: cola });
    await expectAppError(setRoute(ctx, bar, {}), "VALIDATION_FAILED");
    const waiter = (await addMember(ctx, "waiter", { scopeType: "BRANCH", branchId })).ctx;
    await expectAppError(
      createStation(waiter, { branchId, code: "X", name: "X", targetMinutes: "5" }),
      "FORBIDDEN",
    );
    // A route that moves to another station replaces the old one.
    await setRoute(ctx, grill, { menuItemId: cola });
    await setRoute(ctx, bar, { menuItemId: cola });
    const routes = await getDb().kitchenRoute.findMany({
      where: { organizationId: ctx.organizationId, menuItemId: cola },
    });
    expect(routes.map((r) => r.stationId)).toEqual([bar]);
    const extra = await getDb()
      .kitchenRoute.create({
        data: { organizationId: ctx.organizationId, branchId, stationId: bar, categoryId: mains },
      })
      .catch(() => null);
    expect(extra).toBeNull(); // one route per category at a branch
    // A route can be removed.
    const desserts = (await createMenuCategory(ctx, { name: "Desserts" })).id;
    await setRoute(ctx, bar, { categoryId: desserts });
    const route = await getDb().kitchenRoute.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, categoryId: desserts },
    });
    await removeRoute(ctx, route.id);
    expect(
      await getDb().kitchenRoute.count({
        where: { organizationId: ctx.organizationId, categoryId: desserts },
      }),
    ).toBe(0);
  });
});

describe("tickets", () => {
  it("sends a check's items to their stations and shows ready when bumped", async () => {
    const tab = await openTab(ctx, { tableId: table, guests: "2" });
    await addTabLines(ctx, tab.id, {
      lines: [
        { itemId: burger, quantity: "2", seat: 1, note: "well done" },
        { itemId: cola, quantity: "1", seat: 2 },
      ],
    });
    expect((await sendTab(ctx, tab.id)).tickets).toBe(2);
    const [g] = await ticketsOf(grill);
    expect(g).toMatchObject({ label: "T1", guests: 2, status: "OPEN" });
    expect(g.items.map((i) => [i.name, i.quantity.toFixed(), i.note, i.seat])).toEqual([
      ["Burger", "2", "well done", 1],
    ]);
    expect((await ticketsOf(bar))[0].items[0].name).toBe("Cola");
    const statuses = async () =>
      Object.fromEntries((await getTab(ctx, tab.id)).lines.map((l) => [l.name, l.kitchen]));
    expect(await statuses()).toEqual({ Burger: "PREPARING", Cola: "PREPARING" });

    const cook = (await addMember(ctx, "kitchen", { scopeType: "BRANCH", branchId })).ctx;
    await bumpTicket(cook, g.id);
    await bumpTicket(cook, g.id); // a second tap does nothing
    expect(await statuses()).toEqual({ Burger: "READY", Cola: "PREPARING" });
    expect(await ticketsOf(grill)).toHaveLength(0);
    expect((await stationBoard(cook, grill)).lastDone?.id).toBe(g.id);
    await recallTicket(cook, g.id);
    expect(await statuses()).toEqual({ Burger: "PREPARING", Cola: "PREPARING" });
    await expectAppError(recallTicket(cook, g.id), "BUSINESS_RULE_VIOLATION");
    await bumpTicket(cook, g.id);
    expect(
      (await prepTimes(cook, grill, { from: new Date(Date.now() - 3_600_000), to: new Date() }))
        .count,
    ).toBe(1);

    // A voided item is struck through on its ticket.
    const colaLine = (await getTab(ctx, tab.id)).lines.find((l) => l.name === "Cola")!;
    await voidTabLine(ctx, colaLine.id, { reason: "Spilled" });
    expect((await ticketsOf(bar))[0].items[0].voidedAt).not.toBeNull();
  });

  it("sends a paid counter order to the kitchen and shows its status on the shift", async () => {
    const o = await submitOrder(ctx, {
      orderId: randomUUID(),
      registerId: register,
      channel: "TAKEAWAY",
      lines: [{ itemId: burger, quantity: "1", optionIds: [] }],
      payments: [{ method: "CARD", amount: "80" }],
    });
    const t = (await ticketsOf(grill)).find((k) => k.label === o.number)!;
    expect(t.items[0]).toMatchObject({ name: "Burger" });
    const kitchenOf = async () =>
      (await getShift(ctx, shiftId)).orders.find((x) => x.id === o.id)!.kitchen;
    expect(await kitchenOf()).toBe("PREPARING");
    await bumpTicket(ctx, t.id);
    expect(await kitchenOf()).toBe("READY");
    await voidOrder(ctx, o.id, { reason: "Wrong" });
    const item = await getDb().kitchenTicketItem.findFirstOrThrow({ where: { ticketId: t.id } });
    expect(item.voidedAt).not.toBeNull();
  });

  it("makes no ticket where a branch has no station, and keeps screens to their branch", async () => {
    const before = await getDb().kitchenTicket.count({
      where: { organizationId: ctx.organizationId },
    });
    const alexWh = (
      await createWarehouse(ctx, {
        branchId: otherBranch,
        code: "AK",
        name: "Alex K",
        type: "KITCHEN_STORE",
      })
    ).id;
    const alexTill = (
      await createRegister(ctx, {
        branchId: otherBranch,
        warehouseId: alexWh,
        code: "AT",
        name: "Alex",
      })
    ).id;
    await openShift(ctx, alexTill, { openingFloat: "0" });
    await submitOrder(ctx, {
      orderId: randomUUID(),
      registerId: alexTill,
      channel: "TAKEAWAY",
      lines: [{ itemId: cola, quantity: "1", optionIds: [] }],
      payments: [{ method: "CARD", amount: "20" }],
    });
    expect(
      await getDb().kitchenTicket.count({ where: { organizationId: ctx.organizationId } }),
    ).toBe(before);

    const alexCook = (
      await addMember(ctx, "kitchen", { scopeType: "BRANCH", branchId: otherBranch })
    ).ctx;
    expect(await listStations(alexCook)).toHaveLength(0);
    await expectAppError(stationBoard(alexCook, grill), "NOT_FOUND");
    const cashier = (await addMember(ctx, "cashier", { scopeType: "BRANCH", branchId })).ctx;
    const open = (await ticketsOf(bar))[0];
    await expectAppError(bumpTicket(cashier, open.id), "NOT_FOUND");
    const other = (await createTenant("kitchen-other")).ctx;
    await expectAppError(stationBoard(other, grill), "NOT_FOUND");
    await expectAppError(bumpTicket(other, open.id), "NOT_FOUND");
  });
});
