import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postAdjustment, postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import {
  addComboComponent,
  addMenuItemPrice,
  addModifierOption,
  attachModifierGroup,
  createMenuCategory,
  createMenuItem,
  createModifierGroup,
} from "@/modules/menu/service";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { foodCostReport } from "@/modules/analytics/service";
import {
  applyCountryPreset,
  getTaxSetup,
  updateTaxSettings,
  vatSummary,
} from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addCashMovement,
  closeShift,
  createRegister,
  getOrder,
  getShift,
  listRegisters,
  listShortfalls,
  openShift,
  postShortfalls,
  refundOrder,
  submitOrder,
  voidOrder,
} from "./service";

let ctx: TenantContext;
let units: Record<string, string>;
let branchId: string;
let otherBranch: string;
let kitchen: string;
let tomato: string;
let cheese: string;
let register: string;
let burger: string;
let cola: string;
let meal: string;
let extraCheese: string;
let noOnion: string;

const onHand = async (productId: string) => {
  const rows = await getDb().stockBalance.findMany({
    where: { organizationId: ctx.organizationId, warehouseId: kitchen, productId },
  });
  return rows.reduce((a, r) => a + Number(r.onHandQuantity), 0);
};
const sale = (over: Record<string, unknown> = {}) => ({
  orderId: randomUUID(),
  registerId: register,
  channel: "DINE_IN",
  lines: [{ itemId: burger, quantity: "1", optionIds: [] }],
  payments: [{ method: "CARD", amount: "115" }],
  ...over,
});

beforeAll(async () => {
  ({ ctx } = await createTenant("pos"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  // VAT first: prices record whether they include it.
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
  const product = async (sku: string, uom: string, type = "RAW_MATERIAL") =>
    (await createProduct(ctx, { sku, nameEn: sku, type, baseUomId: units[uom] })).id;
  tomato = await product("TOMATO", "kg");
  cheese = await product("CHEESE", "kg");
  const can = await product("COLA", "each", "FINISHED_GOOD");
  for (const [p, q, uom] of [
    [tomato, "1", "kg"],
    [cheese, "1", "kg"],
    [can, "10", "each"],
  ] as const)
    await postOpeningBalance(ctx, {
      warehouseId: kitchen,
      productId: p,
      quantity: q,
      uomId: units[uom],
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
  meal = (
    await createMenuItem(ctx, { code: "MEAL", name: "Meal", categoryId: mains, kind: "COMBO" })
  ).id;
  await addComboComponent(ctx, meal, { componentId: burger });
  await addComboComponent(ctx, meal, { componentId: cola });
  await addMenuItemPrice(ctx, burger, { channel: "DINE_IN", price: "115", effectiveFrom: today });
  await addMenuItemPrice(ctx, cola, { channel: "DINE_IN", price: "11.5", effectiveFrom: today });
  await addMenuItemPrice(ctx, meal, { channel: "DINE_IN", price: "120", effectiveFrom: today });
  const extras = (
    await createModifierGroup(ctx, { name: "Extras", minSelect: "0", maxSelect: "2" })
  ).id;
  await addModifierOption(ctx, extras, {
    name: "Extra cheese",
    priceDelta: "5.75",
    productId: cheese,
    quantity: "0.05",
  });
  await addModifierOption(ctx, extras, { name: "No onion", priceDelta: "0" });
  await attachModifierGroup(ctx, burger, { groupId: extras });
  const options = await getDb().modifierOption.findMany({ where: { groupId: extras } });
  extraCheese = options.find((o) => o.name === "Extra cheese")!.id;
  noOnion = options.find((o) => o.name === "No onion")!.id;

  register = (
    await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL1", name: "Till 1" })
  ).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("registers and shifts", () => {
  it("ties a register to a stock warehouse of its own branch and opens one shift at a time", async () => {
    await expectAppError(
      createRegister(ctx, { branchId: otherBranch, warehouseId: kitchen, code: "X", name: "X" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      createRegister(ctx, { branchId, warehouseId: kitchen, code: "till1", name: "Dup" }),
      "CONFLICT",
    );
    await expectAppError(submitOrder(ctx, sale()), "BUSINESS_RULE_VIOLATION"); // no shift
    const shift = await openShift(ctx, register, { openingFloat: "100" });
    expect(shift.number).toMatch(/^SHF-/);
    await expectAppError(
      openShift(ctx, register, { openingFloat: "0" }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await listRegisters(ctx)).find((r) => r.id === register)?.shifts[0]?.id).toBe(shift.id);
  });
});

describe("orders", () => {
  it("prices from the menu, splits VAT, takes cash with change and uses stock", async () => {
    const before = { tomato: await onHand(tomato), cheese: await onHand(cheese) };
    const input = sale({
      lines: [{ itemId: burger, quantity: "2", optionIds: [extraCheese, noOnion] }],
      payments: [{ method: "CASH", amount: "241.5", tendered: "300" }],
      expectedTotal: "241.5",
    });
    const o = await submitOrder(ctx, input);
    expect(o.number).toMatch(/^POS-/);
    expect(o.gross.toFixed()).toBe("241.5");
    expect(o.change.toFixed()).toBe("58.5");
    expect(o.shortfalls).toBe(0);
    const order = await getOrder(ctx, o.id);
    expect(order.lines[0]).toMatchObject({ name: "Burger" });
    expect(order.lines[0].unitPrice.toFixed()).toBe("120.75");
    expect(order.netAmount.toFixed()).toBe("210");
    expect(order.taxAmount.toFixed()).toBe("31.5");
    expect(order.vatNumber).toBe("310122393500003");
    expect(Number(order.costAmount)).toBeCloseTo(0.4 * 10 + 0.1 * 10, 4);
    expect(await onHand(tomato)).toBeCloseTo(before.tomato - 0.4, 4);
    expect(await onHand(cheese)).toBeCloseTo(before.cheese - 0.1, 4);
    // A retry from the device returns the same order and uses no more stock.
    const again = await submitOrder(ctx, input);
    expect(again).toMatchObject({ id: o.id, number: o.number, duplicate: true });
    expect(again.change.toFixed()).toBe("58.5");
    expect(await onHand(tomato)).toBeCloseTo(before.tomato - 0.4, 4);
  });

  it("refuses changed prices, wrong payments and bad options", async () => {
    await expectAppError(
      submitOrder(ctx, sale({ expectedTotal: "100" })),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      submitOrder(ctx, sale({ payments: [{ method: "CARD", amount: "100" }] })),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      submitOrder(ctx, sale({ payments: [{ method: "CASH", amount: "115", tendered: "100" }] })),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      submitOrder(
        ctx,
        sale({ lines: [{ itemId: burger, quantity: "1", optionIds: [randomUUID()] }] }),
      ),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      submitOrder(ctx, sale({ channel: "DELIVERY" })), // no delivery price
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      submitOrder(ctx, sale({ orderedAt: new Date(Date.now() - 86_400_000).toISOString() })),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("uses each combo component and records a shortfall instead of negative stock", async () => {
    const colaProduct = (
      await getDb().product.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, sku: "COLA" },
      })
    ).id;
    const cans = await onHand(colaProduct);
    const left = await onHand(tomato);
    // 5 meals need 1 kg of tomato; less is left.
    const o = await submitOrder(
      ctx,
      sale({
        lines: [{ itemId: meal, quantity: "5", optionIds: [] }],
        payments: [{ method: "CARD", amount: "600" }],
      }),
    );
    expect(o.shortfalls).toBe(1);
    expect(await onHand(tomato)).toBe(0);
    expect(cans - (await onHand(colaProduct))).toBe(5);
    const open = (await listShortfalls(ctx)).filter((s) => s.order.id === o.id);
    expect(open).toHaveLength(1);
    expect(Number(open[0].quantity)).toBeCloseTo(1 - left, 4);
    // Nothing to post until stock arrives; then it is used.
    expect((await postShortfalls(ctx, kitchen)).posted).toBe(0);
    await postAdjustment(ctx, {
      warehouseId: kitchen,
      productId: tomato,
      direction: "INCREASE",
      quantity: "5",
      uomId: units.kg,
      reasonCode: "FOUND_STOCK",
    });
    expect((await postShortfalls(ctx, kitchen)).posted).toBeGreaterThanOrEqual(1);
    expect((await listShortfalls(ctx)).filter((s) => s.order.id === o.id)).toHaveLength(0);
    expect(await onHand(tomato)).toBeCloseTo(5 - (1 - left), 4);
    // The late posting adds to the order's cost; a void returns that stock too.
    expect(Number((await getOrder(ctx, o.id)).costAmount)).toBeCloseTo(5 * 0.2 * 10 + 5 * 10, 4);
    const level = await onHand(tomato);
    await voidOrder(ctx, o.id, { reason: "Test of late shortfall" });
    expect(await onHand(tomato)).toBeCloseTo(level + 1, 4);
    expect(cans - (await onHand(colaProduct))).toBe(0);
  });

  it("voids in the open shift with stock back; refunds part of an order once", async () => {
    const level = await onHand(tomato);
    const v = await submitOrder(ctx, sale());
    expect(await onHand(tomato)).toBeCloseTo(level - 0.2, 4);
    const cashier = (await addMember(ctx, "cashier", { scopeType: "BRANCH", branchId })).ctx;
    await expectAppError(voidOrder(cashier, v.id, { reason: "x" }), "FORBIDDEN");
    await voidOrder(ctx, v.id, { reason: "Wrong item" });
    expect(await onHand(tomato)).toBeCloseTo(level, 4);
    expect((await getOrder(ctx, v.id)).status).toBe("VOIDED");
    await expectAppError(voidOrder(ctx, v.id, { reason: "again" }), "BUSINESS_RULE_VIOLATION");

    const r = await submitOrder(
      ctx,
      sale({
        lines: [
          { itemId: burger, quantity: "2", optionIds: [] },
          { itemId: cola, quantity: "1", optionIds: [] },
        ],
        payments: [{ method: "CARD", amount: "241.5" }],
      }),
    );
    const lines = (await getOrder(ctx, r.id)).lines;
    const refund = await refundOrder(ctx, r.id, {
      registerId: register,
      method: "CASH",
      reason: "Cold",
      lines: [{ orderLineId: lines[0].id, quantity: "1" }],
    });
    expect(refund.number).toMatch(/^RFD-/);
    expect(refund.amount.toFixed()).toBe("115");
    await expectAppError(
      refundOrder(ctx, r.id, {
        registerId: register,
        method: "CASH",
        reason: "x",
        lines: [{ orderLineId: lines[0].id, quantity: "2" }],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(voidOrder(ctx, r.id, { reason: "x" }), "BUSINESS_RULE_VIOLATION");
    const after = await getOrder(ctx, r.id);
    expect(after.refundedAmount.toFixed()).toBe("115");
    expect(after.lines[0].refundedQuantity.toFixed()).toBe("1");
    expect(after.can.void).toBe(false);
    expect(after.can.refund).toBe(true);
  });

  it("closes the shift against counted cash", async () => {
    const shift = (await listRegisters(ctx)).find((r) => r.id === register)!.shifts[0];
    await addCashMovement(ctx, shift.id, { kind: "PAY_OUT", amount: "20", reason: "Ice" });
    const open = await getShift(ctx, shift.id);
    // float 100 + cash sale 241.5 − cash refund 115 − pay-out 20
    expect(open.totals.expectedCash.toFixed()).toBe("206.5");
    expect(open.totals.voids.count).toBe(2);
    await closeShift(ctx, shift.id, { countedCash: "200", note: "Short" });
    const closed = await getShift(ctx, shift.id);
    expect(closed.status).toBe("CLOSED");
    expect(closed.cashDifference?.toFixed()).toBe("-6.5");
    await expectAppError(
      closeShift(ctx, shift.id, { countedCash: "0" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      addCashMovement(ctx, shift.id, { kind: "PAY_IN", amount: "1", reason: "x" }),
      "BUSINESS_RULE_VIOLATION",
    );
  });
});

describe("reports", () => {
  it("adds POS sales to the VAT summary and the food cost report", async () => {
    const today = businessDate(ctx.timeZone);
    const db = getDb();
    const paid = await db.posOrder.findMany({
      where: { organizationId: ctx.organizationId, status: "PAID" },
      include: { refunds: true },
    });
    const sum = (xs: Array<{ toString(): string }>): number =>
      xs.reduce((a: number, x) => a + Number(x.toString()), 0);
    const tax =
      sum(paid.map((o) => o.taxAmount)) -
      sum(paid.flatMap((o) => o.refunds.map((r) => r.taxAmount)));
    const net =
      sum(paid.map((o) => o.netAmount)) -
      sum(paid.flatMap((o) => o.refunds.map((r) => Number(r.amount) - Number(r.taxAmount))));
    const vat = await vatSummary(ctx, { from: today, to: today });
    expect(sum(vat.map((r) => r.tax))).toBeCloseTo(tax, 2);
    expect(vat.every((r) => r.code?.code === "STD" && r.rate?.toFixed() === "0.15")).toBe(true);
    const report = await foodCostReport(ctx, { from: today, to: today });
    const ruh = report.branches.find((b) => b.branch.code === "RUH")!;
    expect(ruh.posOrders).toBe(paid.length);
    expect(Number(ruh.net)).toBeCloseTo(net, 2);
    expect(Number(ruh.cost)).toBeCloseTo(sum(paid.map((o) => o.costAmount)), 4);
    expect(Number(ruh.cost)).toBeGreaterThan(0);
  });
});

describe("access and integrity", () => {
  it("keeps cashiers to their branch and organizations apart", async () => {
    const elsewhere = (
      await addMember(ctx, "cashier", { scopeType: "BRANCH", branchId: otherBranch })
    ).ctx;
    expect((await listRegisters(elsewhere)).some((r) => r.id === register)).toBe(false);
    await expectAppError(openShift(elsewhere, register, { openingFloat: "0" }), "NOT_FOUND");
    const here = (await addMember(ctx, "cashier", { scopeType: "BRANCH", branchId })).ctx;
    await expectAppError(
      createRegister(here, { branchId, warehouseId: kitchen, code: "T2", name: "T2" }),
      "FORBIDDEN",
    );
    const s = await openShift(here, register, { openingFloat: "50" });
    const o = await submitOrder(here, sale());
    await expectAppError(getOrder(elsewhere, o.id), "NOT_FOUND");
    const other = (await createTenant("pos-other")).ctx;
    await expectAppError(getOrder(other, o.id), "NOT_FOUND");
    await expectAppError(getShift(other, s.id), "NOT_FOUND");
    await expectAppError(submitOrder(other, sale()), "NOT_FOUND");
    // The same order id from another organization is refused, never merged.
    await expectAppError(submitOrder(other, { ...sale(), orderId: o.id }), "NOT_FOUND");
  });

  it("keeps a paid order's amounts fixed in the database", async () => {
    const o = await getDb().posOrder.findFirstOrThrow({
      where: { organizationId: ctx.organizationId },
    });
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.posOrder.update({ where: { id: o.id }, data: { grossAmount: "1" } }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.posOrder.update({ where: { id: o.id }, data: { status: "VOIDED" } }),
      ),
    ).rejects.toThrow(); // a void needs its reason
  });
});
