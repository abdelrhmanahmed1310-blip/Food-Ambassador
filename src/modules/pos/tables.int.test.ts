import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { splitEvenly } from "./rules";
import { createRegister, getOrder, openShift, refundOrder } from "./service";
import {
  addTabLines,
  cancelTab,
  createFloor,
  createTable,
  floorPlan,
  getTab,
  mergeTabs,
  moveTab,
  openTab,
  payTab,
  removeTabLine,
  sendTab,
  updateTabLine,
  voidTabLine,
} from "./tables";

let ctx: TenantContext;
let branchId: string;
let otherBranch: string;
let kitchen: string;
let tomato: string;
let burger: string;
let cola: string;
let floorId: string;
let t1: string;
let t2: string;
let t3: string;
let register: string;

const onHand = async (productId: string) =>
  (
    await getDb().stockBalance.findMany({
      where: { organizationId: ctx.organizationId, warehouseId: kitchen, productId },
    })
  ).reduce((a, r) => a + Number(r.onHandQuantity), 0);
const lineOf = async (tabId: string, name: string) =>
  (await getTab(ctx, tabId)).lines.find((l) => l.name === name && l.status !== "VOIDED")!;

beforeAll(async () => {
  ({ ctx } = await createTenant("tables"));
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
  branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" })).id;
  otherBranch = (await createBranch(ctx, { code: "JED", name: "Jeddah", type: "RESTAURANT" })).id;
  kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  tomato = (
    await createProduct(ctx, {
      sku: "TOMATO",
      nameEn: "Tomato",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  const can = (
    await createProduct(ctx, {
      sku: "COLA",
      nameEn: "Cola",
      type: "FINISHED_GOOD",
      baseUomId: units.each,
    })
  ).id;
  for (const [p, q, u] of [
    [tomato, "10", "kg"],
    [can, "20", "each"],
  ] as const)
    await postOpeningBalance(ctx, {
      warehouseId: kitchen,
      productId: p,
      quantity: q,
      uomId: units[u],
      unitCost: "10",
    });
  const r = (await createRecipe(ctx, {
    code: "BURGER",
    name: "Burger",
    type: "DISH",
    yieldQuantity: "1",
    yieldUomId: units.each,
    portions: "1",
  }))!;
  await addIngredient(ctx, r.versionId, {
    item: `product:${tomato}`,
    quantity: "0.2",
    uomId: units.kg,
  });
  await activateVersion(ctx, r.versionId);
  const today = businessDate(ctx.timeZone);
  const mains = (await createMenuCategory(ctx, { name: "Mains" })).id;
  burger = (
    await createMenuItem(ctx, {
      code: "BURGER",
      name: "Burger",
      categoryId: mains,
      kind: "ITEM",
      recipeId: r.id,
    })
  ).id;
  cola = (
    await createMenuItem(ctx, {
      code: "COLA",
      name: "Cola",
      categoryId: mains,
      kind: "ITEM",
      productId: can,
    })
  ).id;
  await addMenuItemPrice(ctx, burger, { channel: "DINE_IN", price: "115", effectiveFrom: today });
  await addMenuItemPrice(ctx, cola, { channel: "DINE_IN", price: "11.5", effectiveFrom: today });
  register = (
    await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL1", name: "Till" })
  ).id;
  await openShift(ctx, register, { openingFloat: "0" });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("floors and tables", () => {
  it("places tables on a floor whose kitchen uses a warehouse of its branch", async () => {
    await expectAppError(
      createFloor(ctx, { branchId: otherBranch, warehouseId: kitchen, name: "Main" }),
      "BUSINESS_RULE_VIOLATION",
    );
    floorId = (await createFloor(ctx, { branchId, warehouseId: kitchen, name: "Main hall" })).id;
    t1 = (await createTable(ctx, floorId, { code: "t1", seats: "4", gridX: "0", gridY: "0" })).id;
    t2 = (await createTable(ctx, floorId, { code: "T2", seats: "2", gridX: "1", gridY: "0" })).id;
    t3 = (await createTable(ctx, floorId, { code: "T3", seats: "6", gridX: "2", gridY: "0" })).id;
    await expectAppError(
      createTable(ctx, floorId, { code: "T1", seats: "2", gridX: "3", gridY: "0" }),
      "CONFLICT",
    );
    await expectAppError(
      createTable(ctx, floorId, { code: "T9", seats: "0", gridX: "3", gridY: "0" }),
      "VALIDATION_FAILED",
    );
    const waiter = (await addMember(ctx, "waiter", { scopeType: "BRANCH", branchId })).ctx;
    await expectAppError(
      createFloor(waiter, { branchId, warehouseId: kitchen, name: "Terrace" }),
      "FORBIDDEN",
    );
    const plan = await floorPlan(waiter);
    expect(plan.floors[0].tables.map((t) => t.code)).toEqual(["T1", "T2", "T3"]);
  });
});

describe("checks", () => {
  it("holds a course and fires it, and keeps sent items fixed", async () => {
    const waiter = (await addMember(ctx, "waiter", { scopeType: "BRANCH", branchId })).ctx;
    const tab = await openTab(waiter, { tableId: t1, guests: "2" });
    expect(tab.number).toMatch(/^TAB-/);
    await expectAppError(openTab(waiter, { tableId: t1, guests: "1" }), "BUSINESS_RULE_VIOLATION");
    await addTabLines(waiter, tab.id, {
      lines: [
        { itemId: cola, quantity: "1", seat: 2, course: 1 },
        { itemId: burger, quantity: "2", seat: 1, course: 2, hold: true, note: "no onion" },
      ],
    });
    await expectAppError(
      addTabLines(waiter, tab.id, { lines: [{ itemId: randomUUID(), quantity: "1" }] }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await sendTab(waiter, tab.id)).sent).toBe(1); // the cola; burgers are held
    expect((await lineOf(tab.id, "Burger")).status).toBe("PENDING");
    expect((await sendTab(waiter, tab.id, { course: 2 })).sent).toBe(1);
    await expectAppError(sendTab(waiter, tab.id), "BUSINESS_RULE_VIOLATION");
    const b = await lineOf(tab.id, "Burger");
    expect(b).toMatchObject({ status: "SENT", hold: false, note: "no onion", seat: 1 });
    await expectAppError(removeTabLine(waiter, b.id), "BUSINESS_RULE_VIOLATION");
    await expectAppError(updateTabLine(waiter, b.id, { quantity: "3" }), "BUSINESS_RULE_VIOLATION");
    await updateTabLine(waiter, b.id, { seat: 2 }); // moving seats is fine
    // The database keeps a sent item from being deleted or changed.
    await expect(
      withTenantTx(ctx.organizationId, (tx) => tx.posTabLine.delete({ where: { id: b.id } })),
    ).rejects.toThrow();
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.posTabLine.update({ where: { id: b.id }, data: { quantity: "5" } }),
      ),
    ).rejects.toThrow();
  });

  it("voids a sent item with a reason and writes off what the kitchen made", async () => {
    const tab = (await floorPlan(ctx)).floors[0].tables.find((t) => t.code === "T1")!.tab!;
    const b = await lineOf(tab.id, "Burger");
    const waiter = (await addMember(ctx, "waiter", { scopeType: "BRANCH", branchId })).ctx;
    await expectAppError(voidTabLine(waiter, b.id, { reason: "x" }), "FORBIDDEN");
    const before = await onHand(tomato);
    await voidTabLine(ctx, b.id, { reason: "Customer changed their mind" });
    expect(await onHand(tomato)).toBeCloseTo(before - 0.4, 4);
    const voided = (await getTab(ctx, tab.id)).lines.find((l) => l.id === b.id)!;
    expect(voided.status).toBe("VOIDED");
    const doc = await getDb().inventoryDocument.findUniqueOrThrow({
      where: { id: voided.wasteDocId! },
    });
    expect(doc).toMatchObject({ type: "WRITE_OFF", reasonCode: "PREPARED_NOT_SOLD" });
    await expectAppError(voidTabLine(ctx, b.id, { reason: "again" }), "BUSINESS_RULE_VIOLATION");
  });

  it("pays by items in parts, then the rest, and closes the check", async () => {
    const tab = (await floorPlan(ctx)).floors[0].tables.find((t) => t.code === "T1")!.tab!;
    await addTabLines(ctx, tab.id, { lines: [{ itemId: burger, quantity: "2", seat: 1 }] });
    const colaLine = await lineOf(tab.id, "Cola");
    const burgers = await lineOf(tab.id, "Burger");
    const waiter = (await addMember(ctx, "waiter", { scopeType: "BRANCH", branchId })).ctx;
    await expectAppError(
      payTab(waiter, tab.id, {
        orderId: randomUUID(),
        registerId: register,
        payments: [{ method: "CARD", amount: "241.5" }],
      }),
      "NOT_FOUND", // a waiter without pos.sell cannot see the register
    );
    // Seat 2 pays the cola.
    const part = {
      orderId: randomUUID(),
      registerId: register,
      lines: [{ tabLineId: colaLine.id, quantity: "1" }],
      payments: [{ method: "CARD", amount: "11.5" }],
      expectedTotal: "11.5",
    };
    const first = await payTab(ctx, tab.id, part);
    expect(first).toMatchObject({ closed: false, duplicate: false });
    expect((await payTab(ctx, tab.id, part)).duplicate).toBe(true);
    expect((await lineOf(tab.id, "Cola")).paidQuantity.toFixed()).toBe("1");
    await expectAppError(
      payTab(ctx, tab.id, {
        ...part,
        orderId: randomUUID(),
      }),
      "BUSINESS_RULE_VIOLATION", // nothing left on the cola
    );
    // One burger now, then everything left.
    await payTab(ctx, tab.id, {
      orderId: randomUUID(),
      registerId: register,
      lines: [{ tabLineId: burgers.id, quantity: "1" }],
      payments: [{ method: "CASH", amount: "115", tendered: "200" }],
    });
    const tomatoBefore = await onHand(tomato);
    const last = await payTab(ctx, tab.id, {
      orderId: randomUUID(),
      registerId: register,
      payments: [{ method: "CARD", amount: "115" }],
      expectedTotal: "115",
    });
    expect(last.closed).toBe(true);
    expect(await onHand(tomato)).toBeCloseTo(tomatoBefore - 0.2, 4);
    const closed = await getTab(ctx, tab.id);
    expect(closed.status).toBe("CLOSED");
    expect(closed.orders).toHaveLength(3);
    const order = await getOrder(ctx, last.id);
    expect(order.tabId).toBe(tab.id);
    expect(order.lines[0].tabLineId).toBe(burgers.id);
    expect(order.warehouseId).toBe(kitchen);
    // Paid check orders refund like any order.
    await refundOrder(ctx, last.id, {
      registerId: register,
      method: "CARD",
      reason: "Cold",
      lines: [{ orderLineId: order.lines[0].id, quantity: "1" }],
    });
    await expectAppError(
      addTabLines(ctx, tab.id, { lines: [{ itemId: cola, quantity: "1" }] }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("splits a bill evenly into several payments of one order", async () => {
    const tab = await openTab(ctx, { tableId: t2, guests: "3" });
    await addTabLines(ctx, tab.id, { lines: [{ itemId: burger, quantity: "1" }] });
    const parts = splitEvenly(new (await import("@/lib/decimal")).Decimal("115"), 3, "SAR");
    const paid = await payTab(ctx, tab.id, {
      orderId: randomUUID(),
      registerId: register,
      payments: parts.map((p) => ({ method: "CARD", amount: p.toFixed(2) })),
      expectedTotal: "115",
    });
    expect(paid.closed).toBe(true);
    expect((await getOrder(ctx, paid.id)).payments.map((p) => p.amount.toFixed(2))).toEqual([
      "38.34",
      "38.33",
      "38.33",
    ]);
  });

  it("moves a check, merges two, and cancels one nobody ate", async () => {
    const a = await openTab(ctx, { tableId: t1, guests: "2" });
    const b = await openTab(ctx, { tableId: t2, guests: "2" });
    await addTabLines(ctx, a.id, { lines: [{ itemId: cola, quantity: "1" }] });
    await addTabLines(ctx, b.id, { lines: [{ itemId: cola, quantity: "2" }] });
    await expectAppError(moveTab(ctx, a.id, { tableId: t2 }), "BUSINESS_RULE_VIOLATION");
    await moveTab(ctx, a.id, { tableId: t3 });
    expect((await getTab(ctx, a.id)).table?.code).toBe("T3");
    await mergeTabs(ctx, b.id, { intoTabId: a.id });
    const merged = await getTab(ctx, a.id);
    expect(merged.guests).toBe(4);
    expect(merged.lines.map((l) => [l.lineNo, l.quantity.toFixed()])).toEqual([
      [1, "1"],
      [2, "2"],
    ]);
    expect((await getTab(ctx, b.id)).status).toBe("MERGED");
    // A bar check with a name and no table; cancelled while nothing was sent.
    const bar = await openTab(ctx, { branchId, label: "Bar — Sara", guests: "1" });
    await expectAppError(
      openTab(ctx, { branchId, guests: "1" }),
      "BUSINESS_RULE_VIOLATION", // no table and no name
    );
    await addTabLines(ctx, bar.id, { lines: [{ itemId: cola, quantity: "1" }] });
    await cancelTab(ctx, bar.id, { reason: "Left" });
    expect((await getTab(ctx, bar.id)).status).toBe("CANCELLED");
    // With sent items it cannot be cancelled until they are voided.
    await sendTab(ctx, a.id);
    await expectAppError(cancelTab(ctx, a.id, { reason: "x" }), "BUSINESS_RULE_VIOLATION");
  });

  it("keeps checks to their branch and organization", async () => {
    const a = (await floorPlan(ctx)).floors[0].tables.find((t) => t.code === "T3")!.tab!;
    const elsewhere = (
      await addMember(ctx, "waiter", { scopeType: "BRANCH", branchId: otherBranch })
    ).ctx;
    await expectAppError(getTab(elsewhere, a.id), "NOT_FOUND");
    await expectAppError(openTab(elsewhere, { tableId: t1, guests: "1" }), "NOT_FOUND");
    expect((await floorPlan(elsewhere)).floors).toHaveLength(0);
    const cashier = (await addMember(ctx, "cashier", { scopeType: "BRANCH", branchId })).ctx;
    expect((await getTab(cashier, a.id)).can).toMatchObject({ pay: true, serve: false });
    await expectAppError(
      addTabLines(cashier, a.id, { lines: [{ itemId: cola, quantity: "1" }] }),
      "FORBIDDEN",
    );
    const other = (await createTenant("tables-other")).ctx;
    await expectAppError(getTab(other, a.id), "NOT_FOUND");
    await expectAppError(openTab(other, { tableId: t1, guests: "1" }), "NOT_FOUND");
  });
});
