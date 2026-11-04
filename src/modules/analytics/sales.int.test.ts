import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import {
  createRegister,
  getOrder,
  openShift,
  refundOrder,
  submitOrder,
} from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { exportSalesCsv, listTargets, salesAnalytics, setTargets } from "./sales";
import { daysBetween, isoWeekday } from "./sales-rules";

/** Sales analytics and targets (ADR-105). */

const TZ = "Asia/Riyadh";
let ctx: TenantContext;
let register: string;
let shiftId: string;
let branchId: string;
let item: string;
let today: string;

async function sell(channel: "TAKEAWAY" | "DINE_IN", qty: number, total: string) {
  const orderId = randomUUID();
  await submitOrder(ctx, {
    orderId,
    registerId: register,
    shiftId,
    channel,
    lines: [{ itemId: item, quantity: String(qty) }],
    payments: [{ method: "CARD", amount: total }],
  });
  return orderId;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("sales", { baseCurrency: "EGP", timeZone: TZ }));
  today = businessDate(TZ);
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  branchId = (await createBranch(ctx, { code: "B1", name: "Downtown", type: "RESTAURANT" })).id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "K1", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const category = (await createMenuCategory(ctx, { name: "Menu" })).id;
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
  item = (
    await createMenuItem(ctx, {
      code: "WRAP",
      name: "Wrap",
      categoryId: category,
      kind: "ITEM",
      productId,
    })
  ).id;
  for (const channel of ["TAKEAWAY", "DINE_IN"] as const)
    await addMenuItemPrice(ctx, item, { channel, price: "25", effectiveFrom: businessDate(TZ) });
  register = (await createRegister(ctx, { branchId, warehouseId, code: "T1", name: "Till" })).id;
  shiftId = (await openShift(ctx, register, { openingFloat: "0" })).id;
});

describe("sales analytics (ADR-105)", () => {
  it("shows zeros and no ratios before any sale", async () => {
    const r = await salesAnalytics(ctx, { from: today, to: today });
    expect([r.total.orders, r.total.net.toFixed(), r.total.averageTicket]).toEqual([0, "0", null]);
    expect([r.total.growthPrevious, r.total.target, r.total.achievement]).toEqual([
      null,
      null,
      null,
    ]);
    expect(r.branches.map((b) => [b.branch.code, b.orders, b.share])).toEqual([["B1", 0, null]]);
  });

  it("adds paid orders net of refunds, by channel, weekday and hour, against target", async () => {
    await sell("TAKEAWAY", 2, "50");
    await sell("DINE_IN", 4, "100");
    const third = await sell("TAKEAWAY", 2, "50");
    const order = await getOrder(ctx, third);
    await refundOrder(ctx, third, {
      registerId: register,
      method: "CARD",
      reason: "Wrong order",
      lines: [{ orderLineId: order.lines[0].id, quantity: "1" }],
    });
    // A monthly target of 3 100 per month (shared out by day).
    const month = today.slice(5, 7);
    await setTargets(ctx, { branchId, year: today.slice(0, 4), months: { [month]: "3100" } });

    const r = await salesAnalytics(ctx, { from: today, to: today });
    // 50 + 100 + 50 − 25 refunded = 175 over 3 orders.
    expect([r.total.orders, r.total.net.toFixed(2), r.total.averageTicket?.toFixed(2)]).toEqual([
      3,
      "175.00",
      "58.33",
    ]);
    // Nothing was sold the day before: no growth figure rather than an invented one.
    expect(r.total.previous.net.toFixed(2)).toBe("0.00");
    expect(r.total.growthPrevious).toBeNull();
    expect(r.total.growthLastYear).toBeNull();
    const [y, m] = today.split("-").map(Number);
    const days = daysBetween(
      `${today.slice(0, 7)}-01`,
      new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
    );
    expect(r.total.target?.toFixed(4)).toBe((3100 / days).toFixed(4));
    expect(r.branches[0].achievement?.toFixed(4)).toBe((175 / (3100 / days)).toFixed(4));
    expect(
      r.channels.map((c) => [c.channel, c.orders, c.net.toFixed(2), c.share?.toFixed(4)]),
    ).toEqual([
      ["DINE_IN", 1, "100.00", "0.5714"],
      ["TAKEAWAY", 2, "75.00", "0.4286"],
    ]);
    const weekday = r.weekdays[isoWeekday(today) - 1];
    expect([weekday.orders, weekday.net.toFixed(2)]).toEqual([3, "175.00"]);
    expect(r.hours.reduce((a, h) => a + h.orders, 0)).toBe(3);
    expect(r.days).toEqual([expect.objectContaining({ day: today, orders: 3 })]);
    const csv = await exportSalesCsv(ctx, { from: today, to: today });
    expect(csv.split("\n")[0]).toContain("net (EGP)");
    expect(csv).toContain("branch,B1,Downtown,3,175.00");
  });

  it("targets: a year grid, cleared months, permission and validation", async () => {
    const year = today.slice(0, 4);
    const month = today.slice(5, 7);
    const grid = await listTargets(ctx, Number(year));
    expect(grid.canManage).toBe(true);
    expect(grid.branches[0].months[month].amount.toFixed(2)).toBe("3100.00");
    expect(grid.branches[0].currency).toBe("EGP");
    await setTargets(ctx, { branchId, year, months: { [month]: "" } });
    expect((await listTargets(ctx, Number(year))).branches[0].months[month]).toBeUndefined();
    await expectAppError(
      setTargets(ctx, { branchId, year, months: { [month]: "-5" } }),
      "VALIDATION_FAILED",
    );
    const analyst = await addMember(ctx, "analyst");
    await expectAppError(
      setTargets(analyst.ctx, { branchId, year, months: { [month]: "1" } }),
      "FORBIDDEN",
    );
    expect((await listTargets(analyst.ctx, Number(year))).canManage).toBe(false);
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(salesAnalytics(cashier.ctx, { from: today, to: today }), "FORBIDDEN");
    await expectAppError(
      salesAnalytics(ctx, { from: today, to: addDays(today, -1) }),
      "VALIDATION_FAILED",
    );
  });

  it("keeps other organizations out", async () => {
    const { ctx: other } = await createTenant("sales-other", { baseCurrency: "EGP", timeZone: TZ });
    const r = await salesAnalytics(other, { from: today, to: today });
    expect([r.total.orders, r.branches]).toEqual([0, []]);
    await expectAppError(
      setTargets(other, { branchId, year: today.slice(0, 4), months: { "01": "1" } }),
      "NOT_FOUND",
    );
  });
});
