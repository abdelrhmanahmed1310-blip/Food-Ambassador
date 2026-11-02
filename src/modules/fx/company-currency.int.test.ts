import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wasteReport, foodCostReport } from "@/modules/analytics/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance, postTransfer, postWriteOff } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { createShipment } from "@/modules/inventory/shipments";
import { listValuations, valuationByWarehouse } from "@/modules/inventory/valuation-queries";
import { createCompany, listCompanies, updateCompany } from "@/modules/organizations/companies";
import { createOrder } from "@/modules/procurement/orders";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { inCurrency, type TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { createTenant, expectAppError } from "../../../test/support/factories";
import { rateFor, setExchangeRate } from "./service";

/** A company keeping its books in its own currency (ADR-086, step 3a). */

let ctx: TenantContext;
let egCompany: string;
let ruh: string;
let cai: string;
let water: string;
let each: string;
const today = () => businessDate(ctx.timeZone);

beforeAll(async () => {
  ({ ctx } = await createTenant("co-cur", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  egCompany = (
    await createCompany(ctx, {
      code: "EGY",
      name: "Egypt",
      legalName: "Egypt Foods",
      currency: "EGP",
    })
  ).id;
  const ruhBranch = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  const caiBranch = (
    await createBranch(ctx, {
      code: "CAI",
      name: "Cairo",
      type: "RESTAURANT",
      companyId: egCompany,
    })
  ).id;
  ruh = (
    await createWarehouse(ctx, { branchId: ruhBranch, code: "RUH-K", name: "K", type: "MAIN" })
  ).id;
  cai = (
    await createWarehouse(ctx, { branchId: caiBranch, code: "CAI-K", name: "K", type: "MAIN" })
  ).id;
  water = (
    await createProduct(ctx, {
      sku: "WATER",
      nameEn: "Water",
      type: "FINISHED_GOOD",
      baseUomId: each,
    })
  ).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("currency per company (ADR-086)", () => {
  it("a company chooses its currency, fixed once it has stock", async () => {
    const companies = await listCompanies(ctx);
    expect(companies.find((c) => c.id === egCompany)?.currency).toBe("EGP");
    expect(companies.find((c) => c.isDefault)?.currency).toBe("SAR");
    await expectAppError(
      createCompany(ctx, { code: "X", name: "x", legalName: "x", currency: "XYZ" }),
      "BUSINESS_RULE_VIOLATION",
    );
    // No stock yet: the currency may still change (and change back).
    const base = { code: "EGY", name: "Egypt", legalName: "Egypt Foods" };
    await updateCompany(ctx, egCompany, { ...base, currency: "USD" });
    await updateCompany(ctx, egCompany, { ...base, currency: "EGP" });

    await postOpeningBalance(ctx, {
      warehouseId: cai,
      productId: water,
      quantity: "10",
      uomId: each,
      unitCost: "100", // EGP
    });
    await postOpeningBalance(ctx, {
      warehouseId: ruh,
      productId: water,
      quantity: "10",
      uomId: each,
      unitCost: "5", // SAR
    });
    await expectAppError(
      updateCompany(ctx, egCompany, { ...base, currency: "USD" }),
      "BUSINESS_RULE_VIOLATION",
    );
    // The database refuses it too.
    await expect(
      getDb()
        .$executeRaw`UPDATE "companies" SET "currency" = 'USD' WHERE "id" = ${egCompany}::uuid`,
    ).rejects.toThrow(/currency is fixed/);
  });

  it("stock values are in each warehouse's currency; group totals are converted", async () => {
    const rows = (await listValuations(ctx)).items;
    expect(rows.find((r) => r.warehouse.id === cai)).toMatchObject({ currency: "EGP" });
    expect(rows.find((r) => r.warehouse.id === cai)?.totalValue.toFixed()).toBe("1000");
    // No EGP rate yet: the Egyptian stock is left out of the group total and flagged.
    const before = await valuationByWarehouse(ctx);
    expect(before.currency).toBe("SAR");
    expect(before.totalValue.toFixed()).toBe("50");
    expect(before.missingRates).toEqual(["EGP"]);

    await setExchangeRate(ctx, { currency: "EGP", rateDate: today(), rate: "0.075" });
    const after = await valuationByWarehouse(ctx);
    expect(after.totalValue.toFixed()).toBe("125"); // 50 SAR + 1000 EGP × 0.075
    expect(after.missingRates).toEqual([]);
    // One warehouse alone stays in its own currency.
    const one = await listValuations(ctx, { warehouseId: cai });
    expect([one.currency, one.totalValue.toFixed()]).toEqual(["EGP", "1000"]);
  });

  it("cross rates go through the group currency", async () => {
    await setExchangeRate(ctx, { currency: "USD", rateDate: today(), rate: "3.75" });
    const egp = inCurrency(ctx, "EGP");
    const usd = await withTenantTx(ctx.organizationId, (tx) => rateFor(tx, egp, "USD", today()));
    expect(usd.rate.toFixed()).toBe("50"); // 3.75 / 0.075
    const sar = await withTenantTx(ctx.organizationId, (tx) => rateFor(tx, egp, "SAR", today()));
    expect(sar.rate.toFixed(4)).toBe("13.3333");
  });

  it("waste is converted for the group and in the company's own currency for that company", async () => {
    await postWriteOff(ctx, {
      warehouseId: cai,
      productId: water,
      quantity: "1",
      uomId: each,
      stockStatus: "AVAILABLE",
      reasonCode: "DAMAGED",
    });
    const period = { from: today(), to: today() };
    const group = await wasteReport(ctx, period);
    expect(group.currency).toBe("SAR");
    expect(group.total.WASTE.toFixed()).toBe("7.5"); // 100 EGP × 0.075
    const egypt = await foodCostReport(ctx, period, egCompany);
    expect(egypt.currency).toBe("EGP");
    expect(egypt.total.waste.toFixed()).toBe("100");
  });

  it("stock does not move between companies with different currencies", async () => {
    await expectAppError(
      postTransfer(ctx, {
        warehouseId: ruh,
        productId: water,
        toWarehouseId: cai,
        quantity: "1",
        uomId: each,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      createShipment(ctx, { fromWarehouseId: ruh, toWarehouseId: cai }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expect(
      getDb().$executeRaw`
        INSERT INTO "stock_shipments" ("id", "organization_id", "number", "from_warehouse_id", "to_warehouse_id", "created_by_user_id")
        VALUES (gen_random_uuid(), ${ctx.organizationId}::uuid, 'SHP-X', ${ruh}::uuid, ${cai}::uuid, ${ctx.userId}::uuid)`,
    ).rejects.toThrow(/different currencies/);
  });

  it("flows not yet kept in a company's own currency refuse it", async () => {
    const supplierId = (await createSupplier(ctx, { code: "S", name: "S" })).id;
    await expectAppError(
      createOrder(ctx, { supplierId, warehouseId: cai }),
      "BUSINESS_RULE_VIOLATION",
    );
    // The group-currency company is unaffected.
    expect((await createOrder(ctx, { supplierId, warehouseId: ruh })).id).toBeTruthy();
  });
});
