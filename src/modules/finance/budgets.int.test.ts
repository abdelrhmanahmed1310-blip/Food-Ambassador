import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setTargets } from "@/modules/analytics/sales";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createRegister, getOrder, openShift, submitOrder } from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { budgetBranches, budgetGrid, budgetVsActual, setBudgetLine } from "./budgets";
import { createExpenseCategory, recordExpense } from "./expenses";

/** Branch budgets and budget against actual (ADR-110). */

let ctx: TenantContext;
let today: string;
let year: number;
let mm: string;
let branchId: string;
let other: string;
let orderCost: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("budgets", { baseCurrency: "EGP" }));
  today = businessDate(ctx.timeZone);
  year = Number(today.slice(0, 4));
  mm = today.slice(5, 7);
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  branchId = (await createBranch(ctx, { code: "B1", name: "Downtown", type: "RESTAURANT" })).id;
  other = (await createBranch(ctx, { code: "B2", name: "Uptown", type: "RESTAURANT" })).id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "K1", name: "Kitchen", type: "KITCHEN_STORE" })
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
  const item = (
    await createMenuItem(ctx, {
      code: "WRAP",
      name: "Wrap",
      categoryId: category,
      kind: "ITEM",
      productId,
    })
  ).id;
  await addMenuItemPrice(ctx, item, { channel: "TAKEAWAY", price: "25", effectiveFrom: today });
  const registerId = (
    await createRegister(ctx, { branchId, warehouseId, code: "T1", name: "Till" })
  ).id;
  const shiftId = (await openShift(ctx, registerId, { openingFloat: "0" })).id;
  const orderId = randomUUID();
  await submitOrder(ctx, {
    orderId,
    registerId,
    shiftId,
    channel: "TAKEAWAY",
    lines: [{ itemId: item, quantity: "4" }],
    payments: [{ method: "CARD", amount: "100" }],
  });
  orderCost = String((await getOrder(ctx, orderId)).costAmount);
  const rent = (
    await createExpenseCategory(ctx, { code: "RENT", name: "Rent", group: "OCCUPANCY" })
  ).id;
  await recordExpense(ctx, {
    branchId,
    categoryId: rent,
    expenseDate: today,
    description: "Rent",
    netAmount: "1000",
  });
}, 60_000);

describe("branch budgets (ADR-110)", () => {
  it("starts empty: no budget is assumed", async () => {
    const g = await budgetGrid(ctx, branchId, year);
    expect(g.currency).toBe("EGP");
    expect(g.months.every((m) => Object.values(m.rows).every((v) => v === null))).toBe(true);
    const r = await budgetVsActual(ctx, branchId, year);
    expect(r.rows.every((row) => row.ytdVariance === null)).toBe(true);
  });

  it("sets lines by month, takes sales from the targets, and derives the totals", async () => {
    await setTargets(ctx, { branchId, year: String(year), months: { [mm]: "150" } });
    await setBudgetLine(ctx, { branchId, year, line: "COST_OF_SALES", months: { [mm]: "40" } });
    await setBudgetLine(ctx, {
      branchId,
      year,
      line: "OCCUPANCY",
      months: { [mm]: "900", "01": "5" },
    });
    // Clearing a month removes it.
    await setBudgetLine(ctx, { branchId, year, line: "OCCUPANCY", months: { "01": "" } });
    await expectAppError(
      setBudgetLine(ctx, { branchId, year, line: "OCCUPANCY", months: { [mm]: "-1" } }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      setBudgetLine(ctx, { branchId, year, line: "SALES", months: { [mm]: "1" } }),
      "VALIDATION_FAILED",
    );
    const g = await budgetGrid(ctx, branchId, year);
    const month = g.months.find((m) => m.month === mm)!.rows;
    expect(
      [
        month.SALES,
        month.COST_OF_SALES,
        month.GROSS_PROFIT,
        month.OCCUPANCY,
        month.OPERATING_RESULT,
      ].map((v) => v?.toFixed(2)),
    ).toEqual(["150.00", "40.00", "110.00", "900.00", "-790.00"]);
    if (mm !== "01") expect(g.months[0].rows.OCCUPANCY).toBeNull();
  });

  it("compares with POS sales, their stock cost and posted expenses", async () => {
    const r = await budgetVsActual(ctx, branchId, year);
    const row = (k: string) => r.rows.find((x) => x.row === k)!;
    expect(row("SALES").ytdActual?.toFixed(2)).toBe("100.00");
    const sales = row("SALES").ytdVariance!;
    expect([sales.difference.toFixed(2), sales.favourable]).toEqual(["-50.00", false]);
    expect(row("COST_OF_SALES").ytdActual?.toFixed(2)).toBe(Number(orderCost).toFixed(2));
    const occupancy = row("OCCUPANCY").ytdVariance!;
    expect([occupancy.difference.toFixed(2), occupancy.favourable]).toEqual(["100.00", false]);
    expect(row("OCCUPANCY").yearBudget?.toFixed(2)).toBe("900.00");
    // Groups with no budget have no variance, but their actuals still show.
    expect(row("UTILITIES").ytdVariance).toBeNull();
    expect(row("UTILITIES").ytdActual?.toFixed(2)).toBe("0.00");
    // A future year has nothing elapsed yet.
    const next = await budgetVsActual(ctx, branchId, year + 1);
    expect([next.lastMonth, next.rows[0].ytdActual]).toEqual([0, null]);
    // Another branch has its own (empty) figures.
    const b2 = await budgetVsActual(ctx, other, year);
    expect(b2.rows.find((x) => x.row === "SALES")!.ytdActual?.toFixed(2)).toBe("0.00");
  });

  it("is seen at the user's branches and set by finance only", async () => {
    const manager = await addMember(ctx, "branch_manager", {
      scopeType: "BRANCH",
      branchId: other,
    });
    expect((await budgetBranches(manager.ctx)).map((b) => b.code)).toEqual(["B2"]);
    await expectAppError(budgetGrid(manager.ctx, branchId, year), "NOT_FOUND");
    await expectAppError(
      setBudgetLine(manager.ctx, { branchId: other, year, line: "OTHER", months: { [mm]: "1" } }),
      "FORBIDDEN",
    );
    const finance = await addMember(ctx, "finance");
    await setBudgetLine(finance.ctx, {
      branchId: other,
      year,
      line: "OTHER",
      months: { [mm]: "7" },
    });
    expect((await budgetGrid(manager.ctx, other, year)).canManage).toBe(false);
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(budgetBranches(cashier.ctx), "FORBIDDEN");
    const { ctx: stranger } = await createTenant("budgets-other");
    await expectAppError(budgetGrid(stranger, branchId, year), "NOT_FOUND");
  });
});
