import { beforeAll, describe, expect, it } from "vitest";
import {
  addSalesOrderLine,
  confirmSalesOrder,
  createCustomer,
  createSalesOrder,
  deliverSalesOrder,
  getSalesOrder,
  invoiceDelivery,
  setCustomerGroupCompany,
} from "@/modules/b2b/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { setExchangeRate } from "@/modules/fx/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { createCompany } from "@/modules/organizations/companies";
import { importSales } from "@/modules/sales/imports";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { consolidatedPnl, exportConsolidatedCsv } from "./consolidation";
import { createExpenseCategory, recordExpense } from "./expenses";

/** Consolidated group P&L (ADR-112). */

let ctx: TenantContext;
let today: string;
let sisterCustomer: string;
let sister: string;

async function sell(warehouseId: string, customerId: string, productId: string, kg: string) {
  const kgId = (await listUnits(ctx)).find((u) => u.code === "kg")!.id;
  const order = await createSalesOrder(ctx, { customerId, warehouseId });
  await addSalesOrderLine(ctx, order.id, { productId, quantity: kg, uomId: kgId, unitPrice: "50" });
  await confirmSalesOrder(ctx, order.id);
  const lineId = (await getSalesOrder(ctx, order.id)).lines[0].id;
  const d = await deliverSalesOrder(ctx, order.id, { lines: [{ lineId, quantity: kg }] });
  await invoiceDelivery(ctx, d.id, { invoiceDate: today });
}

async function branchWithWarehouse(code: string, companyId?: string) {
  const branchId = (
    await createBranch(ctx, {
      code,
      name: code,
      type: "RESTAURANT",
      ...(companyId ? { companyId } : {}),
    })
  ).id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: `${code}-W`, name: "W", type: "MAIN" })
  ).id;
  return { branchId, warehouseId };
}

beforeAll(async () => {
  ({ ctx } = await createTenant("consolidation", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  today = businessDate(ctx.timeZone);
  const kg = (await listUnits(ctx)).find((u) => u.code === "kg")!.id;
  const sauce = (
    await createProduct(ctx, {
      sku: "SAUCE",
      nameEn: "Sauce",
      type: "FINISHED_GOOD",
      baseUomId: kg,
    })
  ).id;
  sister = (
    await createCompany(ctx, {
      code: "KSA2",
      name: "Retail",
      legalName: "Retail Co",
      currency: "SAR",
    })
  ).id;
  const egypt = (
    await createCompany(ctx, {
      code: "EGY",
      name: "Egypt",
      legalName: "Egypt Foods",
      currency: "EGP",
    })
  ).id;
  const usa = (
    await createCompany(ctx, { code: "USA", name: "USA", legalName: "USA Foods", currency: "USD" })
  ).id;

  // The group's kitchen (default company, SAR) sells 10 kg at 50 to its sister company and 4 kg to a hotel.
  const kitchen = await branchWithWarehouse("CK");
  await postOpeningBalance(ctx, {
    warehouseId: kitchen.warehouseId,
    productId: sauce,
    quantity: "20",
    uomId: kg,
    unitCost: "30",
  });
  sisterCustomer = (await createCustomer(ctx, { code: "RETAIL", name: "Retail Co" })).id;
  await setCustomerGroupCompany(ctx, sisterCustomer, { companyId: sister });
  const hotel = (await createCustomer(ctx, { code: "HOTEL", name: "Hotel" })).id;
  await sell(kitchen.warehouseId, sisterCustomer, sauce, "10");
  await sell(kitchen.warehouseId, hotel, sauce, "4");

  // The sister company takes the 10 kg in at 50 and sells it all for 800.
  const shop = await branchWithWarehouse("SHOP", sister);
  await postOpeningBalance(ctx, {
    warehouseId: shop.warehouseId,
    productId: sauce,
    quantity: "10",
    uomId: kg,
    unitCost: "50",
  });
  const imported = await importSales(ctx, {
    warehouseId: shop.warehouseId,
    text: [
      "date,external_id,item_code,item_type,quantity,net_amount,channel",
      `${today},R-1,SAUCE,PRODUCT,10,800,`,
    ].join("\n"),
  });
  expect(imported).toMatchObject({ ok: true });

  // Egypt pays 1 000 EGP rent (0.075 SAR per EGP); the USA company has no rate.
  const rent = (
    await createExpenseCategory(ctx, { code: "RENT", name: "Rent", group: "OCCUPANCY" })
  ).id;
  const cairo = await branchWithWarehouse("CAI", egypt);
  await recordExpense(ctx, {
    branchId: cairo.branchId,
    categoryId: rent,
    expenseDate: today,
    description: "Rent",
    netAmount: "1000",
  });
  const ny = await branchWithWarehouse("NYC", usa);
  await recordExpense(ctx, {
    branchId: ny.branchId,
    categoryId: rent,
    expenseDate: today,
    description: "Rent",
    netAmount: "10",
  });
  await setExchangeRate(ctx, { currency: "EGP", rateDate: today, rate: "0.075" });
}, 120_000);

describe("consolidated P&L (ADR-112)", () => {
  it("converts each company, eliminates sales between them and leaves out a company with no rate", async () => {
    const r = await consolidatedPnl(ctx, { from: today, to: today });
    expect(r.currency).toBe("SAR");
    expect(r.missingRates).toEqual(["USD"]);
    const byCode = Object.fromEntries(r.companies.map((c) => [c.company.code, c]));
    expect(Object.keys(byCode).sort()).toEqual(["EGY", "KSA2", "MAIN", "USA"]);
    expect(byCode.USA.converted).toBeNull();
    // Egypt: −1 000 EGP → −75 SAR.
    expect([
      byCode.EGY.local.values.OPERATING_RESULT.toFixed(2),
      byCode.EGY.converted!.values.OPERATING_RESULT.toFixed(2),
    ]).toEqual(["-1000.00", "-75.00"]);
    expect(r.intercompanySales.toFixed(2)).toBe("500.00");
    expect([
      r.eliminations.values.SALES.toFixed(2),
      r.eliminations.values.COST_OF_SALES.toFixed(2),
      r.eliminations.values.OPERATING_RESULT.toFixed(2),
    ]).toEqual(["-500.00", "-500.00", "0.00"]);
    // Group: outside sales 200 (hotel) + 800 (shop) = 1 000; the cost of the stock sold is
    // 4 × 30 + 10 × 30 = 420 — the sister's 500 cost was the kitchen's sale.
    const g = r.group.values;
    expect(
      [g.SALES, g.SALES_B2B, g.COST_OF_SALES, g.GROSS_PROFIT, g.OCCUPANCY, g.OPERATING_RESULT].map(
        (v) => v.toFixed(2),
      ),
    ).toEqual(["1000.00", "200.00", "420.00", "580.00", "75.00", "505.00"]);
    expect(r.group.shares.GROSS_PROFIT?.toFixed(2)).toBe("0.58");
    const csv = await exportConsolidatedCsv(ctx, { from: today, to: today });
    expect(csv.split("\n")[0]).toContain("eliminations (SAR),group (SAR)");
    expect(csv).toContain(",-500.00,1000.00,");
  });

  it("without the mark the sale stays in the group's sales", async () => {
    await setCustomerGroupCompany(ctx, sisterCustomer, { companyId: "" });
    const r = await consolidatedPnl(ctx, { from: today, to: today });
    expect([r.intercompanySales.toFixed(2), r.group.values.SALES.toFixed(2)]).toEqual([
      "0.00",
      "1500.00",
    ]);
    await setCustomerGroupCompany(ctx, sisterCustomer, { companyId: sister });
  });

  it("is for organization-wide viewers only", async () => {
    const analyst = await addMember(ctx, "analyst");
    expect(
      (await consolidatedPnl(analyst.ctx, { from: today, to: today })).group.values.SALES.toFixed(
        2,
      ),
    ).toBe("1000.00");
    const branches = await addMember(ctx, "branch_manager");
    await expectAppError(consolidatedPnl(branches.ctx, { from: today, to: today }), "FORBIDDEN");
    await expectAppError(
      setCustomerGroupCompany(analyst.ctx, sisterCustomer, { companyId: "" }),
      "FORBIDDEN",
    );
    const { ctx: other } = await createTenant("consolidation-other");
    await expectAppError(
      setCustomerGroupCompany(other, sisterCustomer, { companyId: "" }),
      "NOT_FOUND",
    );
    await expectAppError(
      setCustomerGroupCompany(ctx, sisterCustomer, { companyId: other.organizationId }),
      "NOT_FOUND",
    );
  });
});
