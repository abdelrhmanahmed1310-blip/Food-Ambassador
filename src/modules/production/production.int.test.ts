import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance, reverseDocument } from "@/modules/inventory/operations";
import { reconcileBalances } from "@/modules/inventory/queries";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { reconcileValuations } from "@/modules/inventory/valuation-queries";
import {
  addRequisitionLine,
  createRequisition,
  submitRequisition,
} from "@/modules/procurement/requisitions";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { traceLot } from "@/modules/traceability/trace";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  cancelProductionOrder,
  completeProduction,
  createProductionOrder,
  getProductionOrder,
  listProductionOrders,
  productionPlan,
  reverseProduction,
  setRecipeOutputProduct,
} from "./service";

let ctx: TenantContext;
let units: Record<string, string>;
let ck: string; // central kitchen
let branchWh: string;
let tomato: string;
let oil: string;
let sauceStock: string;
let sauceRecipe: string;
let today: string;

async function stock(productId: string, warehouseId = ck) {
  const rows = await getDb().stockBalance.findMany({
    where: { organizationId: ctx.organizationId, productId, warehouseId },
  });
  return rows.reduce((a, r) => a + Number(r.onHandQuantity), 0);
}
async function value(productId: string) {
  const v = await getDb().stockValuation.findFirst({
    where: { organizationId: ctx.organizationId, productId, warehouseId: ck },
  });
  return v?.totalValue.toFixed() ?? "0";
}

beforeAll(async () => {
  ({ ctx } = await createTenant("production"));
  today = businessDate(ctx.timeZone);
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const hq = (
    await createBranch(ctx, { code: "CK", name: "Central kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  const shop = (await createBranch(ctx, { code: "ZAM", name: "Zamalek", type: "RESTAURANT" })).id;
  ck = (
    await createWarehouse(ctx, { branchId: hq, code: "CK", name: "Central kitchen", type: "MAIN" })
  ).id;
  branchWh = (
    await createWarehouse(ctx, {
      branchId: shop,
      code: "ZK",
      name: "Zamalek kitchen",
      type: "KITCHEN_STORE",
    })
  ).id;
  tomato = (
    await createProduct(ctx, {
      sku: "TOMATO",
      nameEn: "Tomato",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
      lotTracking: "LOT_AND_EXPIRY",
    })
  ).id;
  oil = (
    await createProduct(ctx, {
      sku: "OIL",
      nameEn: "Oil",
      type: "RAW_MATERIAL",
      baseUomId: units.l,
    })
  ).id;
  sauceStock = (
    await createProduct(ctx, {
      sku: "SAUCE-K",
      nameEn: "Tomato sauce (batch)",
      type: "SEMI_FINISHED",
      baseUomId: units.kg,
      lotTracking: "LOT_AND_EXPIRY",
      shelfLifeDays: "3",
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: ck,
    productId: tomato,
    lotCode: "T-OLD",
    expiresOn: addDays(today, 2),
    quantity: "2",
    uomId: units.kg,
    unitCost: "20",
  });
  await postOpeningBalance(ctx, {
    warehouseId: ck,
    productId: tomato,
    lotCode: "T-NEW",
    expiresOn: addDays(today, 10),
    quantity: "10",
    uomId: units.kg,
    unitCost: "22",
  });
  await postOpeningBalance(ctx, {
    warehouseId: ck,
    productId: oil,
    quantity: "2",
    uomId: units.l,
    unitCost: "80",
  });
  // 2 kg per batch from 2.4 kg tomato (20 % waste → 3 kg gross) and 100 ml oil.
  const r = await createRecipe(ctx, {
    code: "SAUCE",
    name: "Tomato sauce",
    type: "PREPARATION",
    yieldQuantity: "2",
    yieldUomId: units.kg,
  });
  await addIngredient(ctx, r!.versionId, {
    item: `product:${tomato}`,
    quantity: "2.4",
    uomId: units.kg,
    wastePercent: "20",
  });
  await addIngredient(ctx, r!.versionId, {
    item: `product:${oil}`,
    quantity: "100",
    uomId: units.ml,
  });
  await activateVersion(ctx, r!.versionId);
  sauceRecipe = r!.id;
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
  expect(await reconcileValuations(ctx)).toEqual([]);
  await getDb().$disconnect();
});

describe("production", () => {
  it("needs an output product on a preparation", async () => {
    await expectAppError(
      createProductionOrder(ctx, { recipeId: sauceRecipe, warehouseId: ck, plannedQuantity: "4" }),
      "BUSINESS_RULE_VIOLATION",
    );
    const dish = await createRecipe(ctx, {
      code: "PASTA",
      name: "Pasta",
      type: "DISH",
      yieldQuantity: "1",
      yieldUomId: units.each,
      portions: "1",
    });
    await expectAppError(
      setRecipeOutputProduct(ctx, dish!.id, { productId: sauceStock }),
      "BUSINESS_RULE_VIOLATION",
    );
    // A kg yield cannot become an "each" product without a conversion.
    const each = (
      await createProduct(ctx, {
        sku: "JAR",
        nameEn: "Jar",
        type: "FINISHED_GOOD",
        baseUomId: units.each,
      })
    ).id;
    await expectAppError(
      setRecipeOutputProduct(ctx, sauceRecipe, { productId: each }),
      "BUSINESS_RULE_VIOLATION",
    );
    await setRecipeOutputProduct(ctx, sauceRecipe, { productId: sauceStock });
  });

  it("consumes FEFO and puts the output into stock as a lot at exactly the consumed value", async () => {
    const order = await createProductionOrder(ctx, {
      recipeId: sauceRecipe,
      warehouseId: ck,
      plannedQuantity: "4",
    });
    expect(order.number).toMatch(/^PRD-\d{4}-\d{6}$/);
    let view = await getProductionOrder(ctx, order.id);
    expect(
      view.needed.map((n) => [n.product.sku, n.quantity.toFixed(), n.available.toFixed()]),
    ).toEqual([
      ["TOMATO", "6", "6"],
      ["OIL", "0.2", "0.2"],
    ]);
    // The batch may not outlive the oldest tomatoes.
    await expectAppError(
      completeProduction(ctx, order.id, { expiresOn: addDays(today, 5) }),
      "BUSINESS_RULE_VIOLATION",
    );
    const done = await completeProduction(ctx, order.id, { producedQuantity: "3.8" });
    expect(done.documentNumber).toMatch(/^PRO-/);
    view = await getProductionOrder(ctx, order.id);
    // Moving average per product (ADR-021): 6 kg tomato × 260/12 = 130, plus 0.2 l oil × 80 = 16.
    expect([view.status, view.cost?.toFixed(), view.producedQuantityBase?.toFixed()]).toEqual([
      "COMPLETED",
      "146",
      "3.8",
    ]);
    expect(view.outputLot).toMatchObject({ lotCode: order.number });
    expect(view.outputLot?.expiresOn?.toISOString().slice(0, 10)).toBe(addDays(today, 2));
    expect(
      view.used.map((u) => [u.product.sku, u.lot?.lotCode ?? null, u.quantity.toFixed()]),
    ).toEqual([
      ["TOMATO", "T-OLD", "2"],
      ["TOMATO", "T-NEW", "4"],
      ["OIL", null, "0.2"],
    ]);
    // The output carries exactly what the ingredients took.
    expect(view.used.reduce((a, u) => a.plus(u.value), new Decimal(0)).toFixed()).toBe("146");
    expect([await stock(tomato), await stock(oil), await stock(sauceStock)]).toEqual([6, 1.8, 3.8]);
    expect(await value(sauceStock)).toBe("146");
    await expectAppError(completeProduction(ctx, order.id, {}), "BUSINESS_RULE_VIOLATION");

    // Lot genealogy, both directions.
    const out = await traceLot(ctx, view.outputLot!.id);
    expect(out.madeFrom.map((m) => [m.lot?.lotCode ?? null, m.quantity.toFixed()])).toEqual([
      ["T-OLD", "2"],
      ["T-NEW", "4"],
      [null, "0.2"],
    ]);
    const lots = await getDb().inventoryLot.findMany({
      where: { organizationId: ctx.organizationId, productId: tomato },
    });
    const old = await traceLot(ctx, lots.find((l) => l.lotCode === "T-OLD")!.id);
    expect(old.usedIn.map((u) => u.number)).toEqual([order.number]);

    // Reversal only from the order: everything back, output out.
    await expectAppError(
      reverseDocument(ctx, view.document!.id, { reasonCode: "ENTERED_IN_ERROR" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await reverseProduction(ctx, order.id, { reason: "Wrong batch size recorded" });
    expect([await stock(tomato), await stock(oil), await stock(sauceStock)]).toEqual([12, 2, 0]);
    expect(await value(sauceStock)).toBe("0");
    expect((await getProductionOrder(ctx, order.id)).status).toBe("REVERSED");
    await expectAppError(
      reverseProduction(ctx, order.id, { reason: "again" }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("refuses to produce from stock that is not there, and can be cancelled", async () => {
    const big = await createProductionOrder(ctx, {
      recipeId: sauceRecipe,
      warehouseId: ck,
      plannedQuantity: "100",
    });
    expect(
      (await getProductionOrder(ctx, big.id)).needed
        .find((n) => n.product.sku === "TOMATO")
        ?.available.toFixed(),
    ).toBe("12");
    await expectAppError(completeProduction(ctx, big.id, {}), "BUSINESS_RULE_VIOLATION");
    await cancelProductionOrder(ctx, big.id, { reason: "Too big" });
    await expectAppError(completeProduction(ctx, big.id, {}), "BUSINESS_RULE_VIOLATION");
    expect((await listProductionOrders(ctx, { status: "CANCELLED" })).map((o) => o.id)).toEqual([
      big.id,
    ]);
  });

  it("plans production from branch requisitions in whole batches", async () => {
    const req = await createRequisition(ctx, { warehouseId: branchWh });
    await addRequisitionLine(ctx, req.id, {
      productId: sauceStock,
      quantity: "5",
      uomId: units.kg,
    });
    await submitRequisition(ctx, req.id);
    let plan = await productionPlan(ctx, ck);
    const row = () => plan.rows.find((r) => r.product.sku === "SAUCE-K")!;
    // 5 kg asked, none in stock, 2 kg batches → 3 batches = 6 kg.
    expect([
      row().demand.toFixed(),
      row().need.toFixed(),
      row().batches.toFixed(),
      row().suggestedQuantity.toFixed(),
    ]).toEqual(["5", "5", "3", "6"]);
    await createProductionOrder(ctx, {
      recipeId: sauceRecipe,
      warehouseId: ck,
      plannedQuantity: "4",
    });
    plan = await productionPlan(ctx, ck);
    expect([row().planned.toFixed(), row().batches.toFixed()]).toEqual(["4", "1"]);
  });

  it("is limited by permission, site and tenant", async () => {
    const warehouse = (await addMember(ctx, "warehouse")).ctx;
    await expectAppError(
      createProductionOrder(warehouse, {
        recipeId: sauceRecipe,
        warehouseId: ck,
        plannedQuantity: "2",
      }),
      "FORBIDDEN",
    );
    expect((await listProductionOrders(warehouse)).length).toBeGreaterThan(0);
    const other = await createTenant("production-other");
    const id = (await listProductionOrders(ctx))[0].id;
    await expectAppError(getProductionOrder(other.ctx, id), "NOT_FOUND");
    await expectAppError(completeProduction(other.ctx, id, {}), "NOT_FOUND");
    // A reversed batch cannot be turned back into a plan in the database either.
    const reversed = (await listProductionOrders(ctx, { status: "REVERSED" }))[0].id;
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.productionOrder.update({ where: { id: reversed }, data: { status: "PLANNED" } }),
      ),
    ).rejects.toThrow();
  });
});
