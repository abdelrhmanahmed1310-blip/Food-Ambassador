import { beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance, postWriteOff } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { importSales } from "@/modules/sales/imports";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { createExpenseCategory, recordExpense } from "./expenses";
import { branchPnl, exportPnlCsv } from "./pnl";

/** Branch P&L (ADR-111). */

let ctx: TenantContext;
let today: string;
let yesterday: string;
let cairo: string;
let giza: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("pnl", { baseCurrency: "EGP" }));
  today = businessDate(ctx.timeZone);
  yesterday = addDays(today, -1);
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  cairo = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  giza = (await createBranch(ctx, { code: "GIZ", name: "Giza", type: "RESTAURANT" })).id;
  const kitchen = (
    await createWarehouse(ctx, {
      branchId: cairo,
      code: "K1",
      name: "Kitchen",
      type: "KITCHEN_STORE",
    })
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
    warehouseId: kitchen,
    productId,
    quantity: "100",
    uomId: each,
    unitCost: "8",
  });
  // 2 wraps yesterday for 200 and 3 today for 300: the import's stock cost (5 × 8 = 40) is shared by net.
  const imported = await importSales(ctx, {
    warehouseId: kitchen,
    text: [
      "date,external_id,item_code,item_type,quantity,net_amount,channel",
      `${yesterday},S-1,WRAP,PRODUCT,2,200,`,
      `${today},S-2,WRAP,PRODUCT,3,300,`,
    ].join("\n"),
  });
  expect(imported).toMatchObject({ ok: true, imported: 2 });
  await postWriteOff(ctx, {
    warehouseId: kitchen,
    productId,
    quantity: "2",
    uomId: each,
    stockStatus: "AVAILABLE",
    reasonCode: "DAMAGED",
  });
  const rent = (
    await createExpenseCategory(ctx, { code: "RENT", name: "Rent", group: "OCCUPANCY" })
  ).id;
  await recordExpense(ctx, {
    branchId: cairo,
    categoryId: rent,
    expenseDate: today,
    description: "Rent",
    netAmount: "150",
  });
  await recordExpense(ctx, {
    branchId: giza,
    categoryId: rent,
    expenseDate: today,
    description: "Rent",
    netAmount: "90",
  });
}, 60_000);

describe("branch P&L (ADR-111)", () => {
  it("shows each branch and the company total, with shares of sales", async () => {
    const r = await branchPnl(ctx, { from: yesterday, to: today });
    expect(r.columns.map((c) => [c.kind, c.currency])).toEqual([
      ["BRANCH", "EGP"],
      ["BRANCH", "EGP"],
      ["COMPANY", "EGP"],
    ]);
    const [cai, giz, company] = r.columns;
    const v = (c: (typeof r.columns)[number], row: (typeof r.rows)[number]) =>
      c.values[row].toFixed(2);
    // Cairo: 500 sales − 40 cost = 460 gross; 16 written off; 150 rent → 294.
    expect(
      [
        "SALES_IMPORTED",
        "SALES_POS",
        "SALES",
        "COST_OF_SALES",
        "GROSS_PROFIT",
        "STOCK_LOSSES",
        "OCCUPANCY",
        "OPERATING_RESULT",
      ].map((row) => v(cai, row as (typeof r.rows)[number])),
    ).toEqual(["500.00", "0.00", "500.00", "40.00", "460.00", "16.00", "150.00", "294.00"]);
    expect([cai.shares.COST_OF_SALES?.toFixed(3), cai.shares.OPERATING_RESULT?.toFixed(3)]).toEqual(
      ["0.080", "0.588"],
    );
    // Giza only has rent: a loss and no margins.
    expect([v(giz, "OPERATING_RESULT"), giz.shares.OPERATING_RESULT]).toEqual(["-90.00", null]);
    expect(v(company, "OPERATING_RESULT")).toBe("204.00");
    const csv = await exportPnlCsv(ctx, { from: yesterday, to: today });
    expect(csv).toContain("OPERATING_RESULT,294.00,58.8,-90.00,,204.00,40.8");
  });

  it("counts imported sales and their cost on the day sold", async () => {
    const r = await branchPnl(ctx, { from: yesterday, to: yesterday }, { branchId: cairo });
    expect(r.columns.map((c) => c.kind)).toEqual(["TOTAL", "LAST_YEAR"]);
    const [day, lastYear] = r.columns;
    // 200 of 500 → 40 % of the import's cost.
    expect([day.values.SALES.toFixed(2), day.values.COST_OF_SALES.toFixed(2)]).toEqual([
      "200.00",
      "16.00",
    ]);
    expect([day.values.STOCK_LOSSES.toFixed(2), day.values.OCCUPANCY.toFixed(2)]).toEqual([
      "0.00",
      "0.00",
    ]);
    expect(lastYear.values.SALES.toFixed(2)).toBe("0.00");
  });

  it("gives one branch month by month over a longer period", async () => {
    const r = await branchPnl(
      ctx,
      { from: `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`, to: today },
      { branchId: cairo },
    );
    expect(r.columns.map((c) => c.kind)).toEqual(["MONTH", "MONTH", "TOTAL", "LAST_YEAR"]);
    expect(r.columns[2].values.SALES.toFixed(2)).toBe("500.00");
    await expectAppError(branchPnl(ctx, { from: today, to: yesterday }), "VALIDATION_FAILED");
  });

  it("shows only the branches the user may see", async () => {
    const manager = await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: giza });
    const r = await branchPnl(manager.ctx, { from: yesterday, to: today });
    expect(r.columns.map((c) => c.label)).toEqual(["GIZ — Giza"]);
    const hidden = await branchPnl(
      manager.ctx,
      { from: yesterday, to: today },
      { branchId: cairo },
    );
    expect(hidden.columns).toEqual([]);
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(branchPnl(cashier.ctx, { from: today, to: today }), "FORBIDDEN");
    const { ctx: other } = await createTenant("pnl-other");
    expect((await branchPnl(other, { from: yesterday, to: today })).columns).toEqual([]);
  });
});
