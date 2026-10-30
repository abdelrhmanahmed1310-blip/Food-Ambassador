import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addConversion, createProduct, createUnit, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { addOrderLine, createOrder, getOrder, submitOrder } from "./orders";
import { postReceipt } from "./receipts";
import { createOrdersFromPlan, removeReorderRule, reorderPlan, saveReorderRule } from "./reorder";
import { createSupplier, getSupplier, saveSupplierProduct } from "./suppliers";

let ctx: TenantContext;
let units: Record<string, string>;
let mainWh: string;
let otherWh: string;
let rice: string; // kg
let eggs: string; // each, lots; bought by the case (30)
let milk: string; // l, lot + expiry
let oil: string; // l, no supplier
let mills: string;
let farm: string;
const today = businessDate("Africa/Cairo");

const planLine = async (sku: string) =>
  (await reorderPlan(ctx, mainWh)).lines.find((l) => l.rule.product.sku === sku)!;

beforeAll(async () => {
  ({ ctx } = await createTenant("reorder"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  units.case = (
    await createUnit(ctx, { code: "case", nameEn: "Case", nameAr: "كرتونة", dimension: "COUNT" })
  ).id;
  const branchId = (await createBranch(ctx, { code: "ALX", name: "Alex", type: "RESTAURANT" })).id;
  mainWh = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  otherWh = (await createWarehouse(ctx, { branchId, code: "BAR", name: "Bar", type: "BAR" })).id;
  const product = (sku: string, baseUomId: string, extra = {}) =>
    createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId, ...extra }).then(
      (p) => p.id,
    );
  rice = await product("RICE", units.kg);
  eggs = await product("EGGS", units.each, { lotTracking: "LOT" });
  milk = await product("MILK", units.l, { lotTracking: "LOT_AND_EXPIRY" });
  oil = await product("OIL", units.l);
  await addConversion(ctx, eggs, { uomId: units.case, factorToBase: "30" });
  mills = (await createSupplier(ctx, { code: "MILLS", name: "Mills" })).id;
  farm = (await createSupplier(ctx, { code: "FARM", name: "Farm" })).id;
  await saveSupplierProduct(ctx, mills, {
    productId: rice,
    purchaseUomId: units.kg,
    lastUnitPrice: "40",
    preferred: "on",
  });
  await saveSupplierProduct(ctx, farm, {
    productId: rice,
    purchaseUomId: units.kg,
    lastUnitPrice: "39",
  });
  await saveSupplierProduct(ctx, farm, {
    productId: eggs,
    purchaseUomId: units.case,
    lastUnitPrice: "150",
    minOrderQuantity: "2",
  });
  await saveSupplierProduct(ctx, farm, { productId: milk, purchaseUomId: units.l }); // no price yet
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("reorder rules", () => {
  it("stores levels in the base unit and rejects a maximum below the minimum", async () => {
    await saveReorderRule(ctx, {
      warehouseId: mainWh,
      productId: rice,
      uomId: units.g,
      minQuantity: "20000",
      maxQuantity: "100000",
    });
    const rule = await getDb().reorderRule.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, productId: rice },
    });
    expect(rule.minQuantityBase.toFixed()).toBe("20");
    expect(rule.maxQuantityBase.toFixed()).toBe("100");
    await expectAppError(
      saveReorderRule(ctx, {
        warehouseId: mainWh,
        productId: rice,
        uomId: units.kg,
        minQuantity: "50",
        maxQuantity: "10",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      saveReorderRule(ctx, {
        warehouseId: mainWh,
        productId: rice,
        uomId: units.l,
        minQuantity: "1",
        maxQuantity: "2",
      }),
      "BUSINESS_RULE_VIOLATION",
    ); // litres cannot convert to kg
  });

  it("suggests from usable stock plus open orders, from the preferred supplier", async () => {
    await postOpeningBalance(ctx, {
      warehouseId: mainWh,
      productId: rice,
      quantity: "25",
      uomId: units.kg,
      unitCost: "40",
    });
    expect((await planLine("RICE")).suggestion).toBeNull(); // 25 > 20

    // Drop below the minimum with stock that is expired: it does not count.
    await saveReorderRule(ctx, {
      warehouseId: mainWh,
      productId: milk,
      uomId: units.l,
      minQuantity: "10",
      maxQuantity: "40",
    });
    await postOpeningBalance(ctx, {
      warehouseId: mainWh,
      productId: milk,
      lotCode: "OLD",
      expiresOn: addDays(today, -1),
      quantity: "30",
      uomId: units.l,
    });
    const milkLine = await planLine("MILK");
    expect(milkLine.availableBase.toFixed()).toBe("0");
    expect(milkLine.suggestion?.purchaseUnits.toFixed()).toBe("40");
    expect(milkLine.reason).toBe("NO_PRICE"); // never priced by guess

    await saveReorderRule(ctx, {
      warehouseId: mainWh,
      productId: rice,
      uomId: units.kg,
      minQuantity: "30",
      maxQuantity: "100",
    });
    let riceLine = await planLine("RICE");
    expect(riceLine.source?.supplier.code).toBe("MILLS"); // preferred over the cheaper one
    expect(riceLine.suggestion?.purchaseUnits.toFixed()).toBe("75");

    // A draft order for 3 kg counts as on order: 25 + 3 = 28, still at or below 30.
    const { id } = await createOrder(ctx, { supplierId: mills, warehouseId: mainWh });
    await addOrderLine(ctx, id, {
      productId: rice,
      uomId: units.kg,
      quantity: "3",
      unitPrice: "40",
    });
    riceLine = await planLine("RICE");
    expect(riceLine.onOrderBase.toFixed()).toBe("3");
    expect(riceLine.suggestion?.purchaseUnits.toFixed()).toBe("72");
  });

  it("rounds to whole purchase units and honours the supplier minimum", async () => {
    await saveReorderRule(ctx, {
      warehouseId: mainWh,
      productId: eggs,
      uomId: units.each,
      minQuantity: "30",
      maxQuantity: "40",
    });
    const line = await planLine("EGGS");
    // 40 eggs needed → 2 cases (also the supplier's minimum).
    expect(line.suggestion?.purchaseUnits.toFixed()).toBe("2");
    expect(line.suggestion?.base.toFixed()).toBe("60");
  });

  it("creates one draft order per supplier at the last price and skips unpriced lines", async () => {
    await saveReorderRule(ctx, {
      warehouseId: mainWh,
      productId: oil,
      uomId: units.l,
      minQuantity: "5",
      maxQuantity: "10",
    });
    const plan = await reorderPlan(ctx, mainWh);
    expect(plan.lines.find((l) => l.rule.product.sku === "OIL")?.reason).toBe("NO_SUPPLIER");
    const ids = plan.lines.map((l) => l.rule.id);
    const result = await createOrdersFromPlan(ctx, mainWh, ids);
    expect(result.skipped.sort()).toEqual(["MILK", "OIL"]);
    expect(result.orders).toHaveLength(2); // Mills (rice), Farm (eggs)
    const orders = await Promise.all(result.orders.map((o) => getOrder(ctx, o.id)));
    const bySupplier = Object.fromEntries(orders.map((o) => [o.supplier.code, o]));
    expect(bySupplier.MILLS.status).toBe("DRAFT");
    expect(
      bySupplier.MILLS.lines.map((l) => [l.quantity.toFixed(), l.unitPrice.toFixed()]),
    ).toEqual([["72", "40"]]);
    expect(bySupplier.FARM.lines.map((l) => [l.uom.code, l.quantity.toFixed()])).toEqual([
      ["case", "2"],
    ]);
    expect(bySupplier.FARM.totalAmount.toFixed()).toBe("300"); // 2 cases × 150
    // Once ordered, nothing more is suggested for those products.
    const after = await reorderPlan(ctx, mainWh);
    expect(after.lines.find((l) => l.rule.product.sku === "RICE")?.suggestion).toBeNull();
    expect(after.lines.find((l) => l.rule.product.sku === "EGGS")?.suggestion).toBeNull();
    await expectAppError(createOrdersFromPlan(ctx, mainWh, []), "BUSINESS_RULE_VIOLATION");
  });

  it("is scoped by warehouse and permission", async () => {
    const analyst = await addMember(ctx, "analyst");
    expect((await reorderPlan(analyst.ctx, mainWh)).canManage).toBe(false);
    await expectAppError(
      saveReorderRule(analyst.ctx, {
        warehouseId: mainWh,
        productId: rice,
        uomId: units.kg,
        minQuantity: "1",
        maxQuantity: "2",
      }),
      "FORBIDDEN",
    );
    const scoped = await addMember(ctx, "branch_manager", {
      scopeType: "WAREHOUSE",
      warehouseId: otherWh,
    });
    await expectAppError(reorderPlan(scoped.ctx, mainWh), "NOT_FOUND");
    await expectAppError(createOrdersFromPlan(scoped.ctx, mainWh, ["x"]), "NOT_FOUND");
    const { ctx: other } = await createTenant("reorder-other");
    await expectAppError(reorderPlan(other, mainWh), "NOT_FOUND");
    const rule = await getDb().reorderRule.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, productId: oil },
    });
    await expectAppError(removeReorderRule(other, rule.id), "NOT_FOUND");
    await removeReorderRule(ctx, rule.id);
  });
});

describe("supplier price history", () => {
  it("lists prices actually charged on posted receipts", async () => {
    const { id } = await createOrder(ctx, { supplierId: farm, warehouseId: otherWh });
    await addOrderLine(ctx, id, {
      productId: rice,
      uomId: units.kg,
      quantity: "10",
      unitPrice: "39",
    });
    await submitOrder(ctx, id);
    const order = await getOrder(ctx, id);
    await postReceipt(ctx, id, {
      lines: [
        { purchaseOrderLineId: order.lines[0].id, receivedQuantity: "10", unitPrice: "41.5" },
      ],
    });
    const { priceHistory } = await getSupplier(ctx, farm);
    expect(
      priceHistory.map((p) => [p.product.sku, p.unitPrice.toFixed(), p.orderedUnitPrice.toFixed()]),
    ).toEqual([["RICE", "41.5", "39"]]);
  });
});
