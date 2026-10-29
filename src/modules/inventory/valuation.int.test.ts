import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { createCount, getCount, postCount, recordCountedQuantity, submitCount } from "./counts";
import {
  postAdjustment,
  postOpeningBalance,
  postStatusChange,
  postTransfer,
  postWriteOff,
  reverseDocument,
  revalueStock,
} from "./operations";
import { getDocument, listMovements, reconcileBalances } from "./queries";
import { getValuation, listValuations, reconcileValuations } from "./valuation-queries";

let ctx: TenantContext;
let units: Record<string, string>;
let branchId: string;
let mainWh: string;
let kitchenWh: string;
let flour: string; // base g; entered in kg
let oil: string; // base ml
let salt: string; // base g, opened without a cost

async function valuation(productId: string, warehouseId: string) {
  const v = await getDb().stockValuation.findUnique({
    where: {
      organizationId_warehouseId_productId: {
        organizationId: ctx.organizationId,
        warehouseId,
        productId,
      },
    },
  });
  return v
    ? {
        quantity: v.quantity.toFixed(),
        totalValue: v.totalValue.toFixed(),
        averageUnitCost: v.averageUnitCost?.toFixed() ?? null,
        costMissing: v.costMissing,
      }
    : null;
}

async function entriesOf(documentId: string) {
  return getDb().inventoryLedgerEntry.findMany({
    where: { organizationId: ctx.organizationId, documentId },
    orderBy: { id: "asc" },
  });
}

async function orgValue(productId: string) {
  const agg = await getDb().stockValuation.aggregate({
    where: { organizationId: ctx.organizationId, productId },
    _sum: { totalValue: true },
  });
  return new Decimal((agg._sum.totalValue ?? 0).toString()).toFixed();
}

beforeAll(async () => {
  ({ ctx } = await createTenant("valuation"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  branchId = (await createBranch(ctx, { code: "ALX", name: "Alexandria", type: "RESTAURANT" })).id;
  mainWh = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  kitchenWh = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const product = (sku: string, baseUomId: string) =>
    createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId }).then((p) => p.id);
  flour = await product("FLOUR", units.g);
  oil = await product("OIL", units.ml);
  salt = await product("SALT", units.g);
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
  expect(await reconcileValuations(ctx)).toEqual([]);
  await getDb().$disconnect();
});

describe("moving weighted average through the ledger", () => {
  it("values an opening balance at its entered cost, per base unit", async () => {
    const { documentId } = await postOpeningBalance(ctx, {
      warehouseId: mainWh,
      productId: flour,
      quantity: "10",
      uomId: units.kg,
      unitCost: "20", // per kg → 0.02 per g
    });
    const [entry] = await entriesOf(documentId);
    expect(entry.costSource).toBe("ENTERED");
    expect(entry.unitCost?.toFixed()).toBe("0.02");
    expect(entry.valueDelta.toFixed()).toBe("200");
    expect(await valuation(flour, mainWh)).toEqual({
      quantity: "10000",
      totalValue: "200",
      averageUnitCost: "0.02",
      costMissing: false,
    });
  });

  it("values a gain without a cost at the average and a write-off at the average", async () => {
    const gain = await postAdjustment(ctx, {
      warehouseId: mainWh,
      productId: flour,
      direction: "INCREASE",
      quantity: "500",
      uomId: units.g,
      reasonCode: "FOUND_STOCK",
    });
    expect((await entriesOf(gain.documentId))[0]).toMatchObject({ costSource: "AVERAGE" });
    expect((await valuation(flour, mainWh))?.totalValue).toBe("210");

    const writeOff = await postWriteOff(ctx, {
      warehouseId: mainWh,
      productId: flour,
      stockStatus: "AVAILABLE",
      quantity: "1.5",
      uomId: units.kg,
      reasonCode: "DAMAGED",
    });
    const [entry] = await entriesOf(writeOff.documentId);
    expect(entry.valueDelta.toFixed()).toBe("-30");
    expect(await valuation(flour, mainWh)).toMatchObject({
      quantity: "9000",
      totalValue: "180",
      averageUnitCost: "0.02",
    });
  });

  it("re-averages when stock arrives at a different cost", async () => {
    // A second opening balance is refused after movements; use a costed transfer source instead:
    // open oil in the kitchen at one cost and in main at another, then move kitchen → main.
    await postOpeningBalance(ctx, {
      warehouseId: mainWh,
      productId: oil,
      quantity: "3",
      uomId: units.l,
      unitCost: "30", // per l → 0.03 per ml, value 90
    });
    await postOpeningBalance(ctx, {
      warehouseId: kitchenWh,
      productId: oil,
      quantity: "1",
      uomId: units.l,
      unitCost: "50", // 0.05 per ml, value 50
    });
    const before = await orgValue(oil);
    const transfer = await postTransfer(ctx, {
      warehouseId: kitchenWh,
      toWarehouseId: mainWh,
      productId: oil,
      quantity: "1",
      uomId: units.l,
    });
    const [out, inbound] = await entriesOf(transfer.documentId);
    expect(out.valueDelta.toFixed()).toBe("-50");
    expect(inbound).toMatchObject({ costSource: "TRANSFER" });
    expect(inbound.valueDelta.toFixed()).toBe("50");
    expect(await orgValue(oil)).toBe(before); // transfers neither create nor destroy value
    expect(await valuation(oil, mainWh)).toEqual({
      quantity: "4000",
      totalValue: "140",
      averageUnitCost: "0.035",
      costMissing: false,
    });
    // Kitchen is empty: no value left behind, last average kept.
    expect(await valuation(oil, kitchenWh)).toEqual({
      quantity: "0",
      totalValue: "0",
      averageUnitCost: "0.05",
      costMissing: false,
    });
  });

  it("does not change value on a status change", async () => {
    await postStatusChange(ctx, {
      warehouseId: mainWh,
      productId: oil,
      fromStatus: "AVAILABLE",
      toStatus: "QUARANTINE",
      quantity: "4",
      uomId: units.l,
      reasonCode: "QUALITY_CHECK",
    });
    expect((await valuation(oil, mainWh))?.totalValue).toBe("140");
    await postStatusChange(ctx, {
      warehouseId: mainWh,
      productId: oil,
      fromStatus: "QUARANTINE",
      toStatus: "AVAILABLE",
      quantity: "4",
      uomId: units.l,
      reasonCode: "RELEASED_AFTER_INSPECTION",
    });
    expect(await valuation(oil, mainWh)).toMatchObject({ quantity: "4000", totalValue: "140" });
  });

  it("reversing an outbound movement restores exactly what it took", async () => {
    const writeOff = await postWriteOff(ctx, {
      warehouseId: mainWh,
      productId: oil,
      stockStatus: "AVAILABLE",
      quantity: "1",
      uomId: units.l,
      reasonCode: "SPOILED",
    });
    expect((await valuation(oil, mainWh))?.totalValue).toBe("105");
    const reversal = await reverseDocument(ctx, writeOff.documentId, {
      reasonCode: "ENTERED_IN_ERROR",
    });
    const [entry] = await entriesOf(reversal.documentId);
    expect(entry).toMatchObject({ costSource: "RESTORED" });
    expect(entry.valueDelta.toFixed()).toBe("35");
    expect((await valuation(oil, mainWh))?.totalValue).toBe("140");
  });

  it("reversing an inbound entry at a wrong price takes out exactly what it added", async () => {
    const butter = (
      await createProduct(ctx, {
        sku: "BUTTER",
        nameEn: "Butter",
        type: "RAW_MATERIAL",
        baseUomId: units.kg,
      })
    ).id;
    const open = (unitCost: string) =>
      postOpeningBalance(ctx, {
        warehouseId: mainWh,
        productId: butter,
        quantity: "10",
        uomId: units.kg,
        unitCost,
      });
    await open("10");
    const wrong = await open("100");
    expect((await valuation(butter, mainWh))?.totalValue).toBe("1100");
    const reversal = await reverseDocument(ctx, wrong.documentId, { reasonCode: "WRONG_QUANTITY" });
    const [entry] = await entriesOf(reversal.documentId);
    expect(entry.costSource).toBe("RESTORED");
    expect(entry.valueDelta.toFixed()).toBe("-1000");
    expect(await valuation(butter, mainWh)).toEqual({
      quantity: "10",
      totalValue: "100",
      averageUnitCost: "10",
      costMissing: false,
    });
  });

  it("reversing a transfer moves stock back without creating value", async () => {
    const before = await orgValue(oil);
    const transfer = await postTransfer(ctx, {
      warehouseId: mainWh,
      toWarehouseId: kitchenWh,
      productId: oil,
      quantity: "2",
      uomId: units.l,
    });
    expect((await valuation(oil, kitchenWh))?.totalValue).toBe("70");
    const reversal = await reverseDocument(ctx, transfer.documentId, {
      reasonCode: "WRONG_QUANTITY",
    });
    const entries = await entriesOf(reversal.documentId);
    expect(entries.map((e) => e.costSource).sort()).toEqual(["AVERAGE", "TRANSFER"]);
    expect(await orgValue(oil)).toBe(before);
    expect(await valuation(oil, mainWh)).toMatchObject({ quantity: "4000", totalValue: "140" });
    expect(await valuation(oil, kitchenWh)).toMatchObject({ quantity: "0", totalValue: "0" });
  });

  it("values a count gain at the average", async () => {
    const { id } = await createCount(ctx, { warehouseId: mainWh });
    const count = await getCount(ctx, id);
    for (const l of count.lines) {
      const counted =
        l.product.sku === "FLOUR"
          ? new Decimal(l.expectedQuantity.toString()).plus(1000).toFixed()
          : l.expectedQuantity.toString();
      await recordCountedQuantity(ctx, id, l.id, { countedQuantity: counted });
    }
    await submitCount(ctx, id);
    await postCount(ctx, id);
    expect(await valuation(flour, mainWh)).toMatchObject({ quantity: "10000", totalValue: "200" });
  });
});

describe("unknown costs and revaluation", () => {
  it("never invents a cost: stock opened without one is flagged until revalued", async () => {
    const { documentId } = await postOpeningBalance(ctx, {
      warehouseId: mainWh,
      productId: salt,
      quantity: "2",
      uomId: units.kg,
    });
    const [entry] = await entriesOf(documentId);
    expect(entry.costSource).toBe("NONE");
    expect(entry.unitCost).toBeNull();
    expect(entry.valueDelta.toFixed()).toBe("0");
    expect(await valuation(salt, mainWh)).toEqual({
      quantity: "2000",
      totalValue: "0",
      averageUnitCost: null,
      costMissing: true,
    });
    const missing = await listValuations(ctx, { costMissing: true });
    expect(missing.items.map((r) => r.product.sku)).toEqual(["SALT"]);

    const reval = await revalueStock(ctx, {
      warehouseId: mainWh,
      productId: salt,
      unitCost: "0.0125",
      reasonCode: "MISSING_COST",
    });
    expect(reval.number).toMatch(/^RVL-\d{4}-\d{6}$/);
    expect(reval.valueDelta).toBe("25");
    expect(await valuation(salt, mainWh)).toEqual({
      quantity: "2000",
      totalValue: "25",
      averageUnitCost: "0.0125",
      costMissing: false,
    });

    const doc = await getDocument(ctx, reval.documentId);
    expect(doc.type).toBe("REVALUATION");
    expect(doc.canReverse).toBe(false);
    expect(doc.revaluation?.previousValue.toFixed()).toBe("0");
    expect(doc.revaluation?.newValue.toFixed()).toBe("25");
    await expectAppError(
      reverseDocument(ctx, reval.documentId, { reasonCode: "ENTERED_IN_ERROR" }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("reverses a write-off of uncosted stock (zero value) and keeps the flag", async () => {
    const sugar = (
      await createProduct(ctx, {
        sku: "SUGAR",
        nameEn: "Sugar",
        type: "RAW_MATERIAL",
        baseUomId: units.g,
      })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId: kitchenWh,
      productId: sugar,
      quantity: "500",
      uomId: units.g,
    });
    const writeOff = await postWriteOff(ctx, {
      warehouseId: kitchenWh,
      productId: sugar,
      stockStatus: "AVAILABLE",
      quantity: "100",
      uomId: units.g,
      reasonCode: "SPOILED",
    });
    await reverseDocument(ctx, writeOff.documentId, { reasonCode: "ENTERED_IN_ERROR" });
    expect(await valuation(sugar, kitchenWh)).toEqual({
      quantity: "500",
      totalValue: "0",
      averageUnitCost: null,
      costMissing: true,
    });
    // A gain without a cost is not valued from the unreliable mix either.
    const gain = await postAdjustment(ctx, {
      warehouseId: kitchenWh,
      productId: sugar,
      direction: "INCREASE",
      quantity: "10",
      uomId: units.g,
      reasonCode: "FOUND_STOCK",
    });
    expect((await entriesOf(gain.documentId))[0].costSource).toBe("NONE");
  });

  it("revalues stock with a known average and rejects invalid costs", async () => {
    const r = await revalueStock(ctx, {
      warehouseId: mainWh,
      productId: flour,
      unitCost: "0.021",
      reasonCode: "SUPPLIER_PRICE_CHANGE",
    });
    expect(r.valueDelta).toBe("10");
    expect((await valuation(flour, mainWh))?.totalValue).toBe("210");
    await expectAppError(
      revalueStock(ctx, {
        warehouseId: mainWh,
        productId: flour,
        unitCost: "-1",
        reasonCode: "COST_CORRECTION",
      }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      revalueStock(ctx, {
        warehouseId: mainWh,
        productId: flour,
        unitCost: "1",
        reasonCode: "OTHER",
      }),
      "VALIDATION_FAILED",
    ); // OTHER needs a note
  });

  it("is idempotent for the same submission", async () => {
    const input = {
      warehouseId: mainWh,
      productId: flour,
      unitCost: "0.021",
      reasonCode: "COST_CORRECTION",
      idempotencyKey: crypto.randomUUID(),
    };
    const a = await revalueStock(ctx, input);
    const b = await revalueStock(ctx, input);
    expect(b.documentId).toBe(a.documentId);
    const count = await getDb().stockRevaluation.count({
      where: { organizationId: ctx.organizationId, documentId: a.documentId },
    });
    expect(count).toBe(1);
  });
});

describe("rounding and concurrency", () => {
  it("parallel issues never leave value behind or go negative", async () => {
    const pepper = (
      await createProduct(ctx, {
        sku: "PEPPER",
        nameEn: "Pepper",
        type: "RAW_MATERIAL",
        baseUomId: units.each,
      })
    ).id;
    // 3 units worth 10.0000 in total: shares cannot all be equal.
    await postOpeningBalance(ctx, {
      warehouseId: mainWh,
      productId: pepper,
      quantity: "3",
      uomId: units.each,
      unitCost: "3.333333",
    });
    expect((await valuation(pepper, mainWh))?.totalValue).toBe("10");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        postWriteOff(ctx, {
          warehouseId: mainWh,
          productId: pepper,
          stockStatus: "AVAILABLE",
          quantity: "1",
          uomId: units.each,
          reasonCode: "DAMAGED",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await valuation(pepper, mainWh)).toMatchObject({ quantity: "0", totalValue: "0" });
    const issued = await getDb().inventoryLedgerEntry.aggregate({
      where: { organizationId: ctx.organizationId, productId: pepper, movementType: "WRITE_OFF" },
      _sum: { valueDelta: true },
    });
    expect(issued._sum.valueDelta?.toFixed()).toBe("-10");
  });
});

describe("cost visibility and isolation", () => {
  it("hides costs from users without inventory.valuation.view", async () => {
    const staff = await addMember(ctx, "warehouse");
    const movements = await listMovements(staff.ctx, { productId: flour });
    expect(movements.items.length).toBeGreaterThan(0);
    expect(movements.items.every((m) => m.unitCost === null && m.valueDelta === null)).toBe(true);
    const listed = await listValuations(staff.ctx);
    expect(listed.items).toEqual([]);
    expect(listed.totalValue.toFixed()).toBe("0");
    await expectAppError(getValuation(staff.ctx, mainWh, flour), "NOT_FOUND");
    await expectAppError(
      revalueStock(staff.ctx, {
        warehouseId: mainWh,
        productId: flour,
        unitCost: "1",
        reasonCode: "COST_CORRECTION",
      }),
      "FORBIDDEN",
    );

    const analyst = await addMember(ctx, "analyst");
    const seen = await listValuations(analyst.ctx);
    expect(seen.items.map((r) => r.product.sku)).toContain("FLOUR");
    expect((await listMovements(analyst.ctx, { productId: flour })).items[0].valueDelta).not.toBe(
      null,
    );
    await expectAppError(
      revalueStock(analyst.ctx, {
        warehouseId: mainWh,
        productId: flour,
        unitCost: "1",
        reasonCode: "COST_CORRECTION",
      }),
      "FORBIDDEN",
    );

    const finance = await addMember(ctx, "finance");
    await revalueStock(finance.ctx, {
      warehouseId: mainWh,
      productId: flour,
      unitCost: "0.02",
      reasonCode: "COST_CORRECTION",
    });
    expect((await valuation(flour, mainWh))?.totalValue).toBe("200");
  });

  it("limits warehouse-scoped valuation access to that warehouse", async () => {
    const scoped = await addMember(ctx, "branch_manager", {
      scopeType: "WAREHOUSE",
      warehouseId: kitchenWh,
    });
    const rows = await listValuations(scoped.ctx);
    expect(rows.items.every((r) => r.warehouse.id === kitchenWh)).toBe(true);
    await expectAppError(getValuation(scoped.ctx, mainWh, flour), "NOT_FOUND");
  });

  it("keeps valuations invisible to other tenants", async () => {
    const { ctx: other } = await createTenant("valuation-other");
    expect((await listValuations(other)).items).toEqual([]);
    await expectAppError(getValuation(other, mainWh, flour), "NOT_FOUND");
    await expectAppError(
      revalueStock(other, {
        warehouseId: mainWh,
        productId: flour,
        unitCost: "1",
        reasonCode: "COST_CORRECTION",
      }),
      "NOT_FOUND",
    );
    // Row-level security: even an unfiltered query sees only the tenant's own rows.
    const visible = await withTenantTx(other.organizationId, (tx) =>
      tx.stockValuation.count({ where: { organizationId: ctx.organizationId } }),
    );
    expect(visible).toBe(0);
  });

  it("rejects direct edits of revaluation history", async () => {
    await expect(
      getDb()
        .$executeRaw`UPDATE "stock_revaluations" SET "new_value" = 0 WHERE "organization_id" = ${ctx.organizationId}::uuid`,
    ).rejects.toThrow();
  });
});
