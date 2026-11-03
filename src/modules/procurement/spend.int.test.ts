import { beforeAll, describe, expect, it } from "vitest";
import { createCategory } from "@/modules/catalog/categories";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { setExchangeRate } from "@/modules/fx/service";
import { businessDate } from "@/modules/inventory/rules";
import { listCompanies } from "@/modules/organizations/companies";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { addOrderLine, createOrder, getOrder, submitOrder } from "./orders";
import { postReceipt } from "./receipts";
import {
  addSupplierReturnLine,
  createSupplierReturn,
  getSupplierReturn,
  postSupplierReturn,
} from "./returns";
import { exportPriceVarianceCsv, exportSpendCsv, priceVarianceReport, spendReport } from "./spend";
import { createSupplier } from "./suppliers";

/** Spend and price variance from what was received (ADR-095). */

let ctx: TenantContext;
let units: Record<string, string>;
let warehouseId: string;
let flour: string;
let oil: string;
const sup: Record<string, string> = {};
let today: string;
let nileReceipt: string;

async function receive(
  supplierId: string,
  lines: Array<{
    productId: string;
    uom: string;
    quantity: string;
    ordered: string;
    charged: string;
  }>,
) {
  const { id } = await createOrder(ctx, { supplierId, warehouseId });
  for (const l of lines)
    await addOrderLine(ctx, id, {
      productId: l.productId,
      uomId: units[l.uom],
      quantity: l.quantity,
      unitPrice: l.ordered,
    });
  await submitOrder(ctx, id);
  const order = await getOrder(ctx, id);
  return (
    await postReceipt(ctx, id, {
      lines: lines.map((l, i) => ({
        purchaseOrderLineId: order.lines[i].id,
        receivedQuantity: l.quantity,
        unitPrice: l.charged,
      })),
    })
  ).id;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("spend"));
  today = businessDate(ctx.timeZone);
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  warehouseId = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" }))
    .id;
  const dry = await createCategory(ctx, { code: "DRY", name: "Dry goods" });
  const oils = await createCategory(ctx, { code: "OIL", name: "Oils" });
  flour = (
    await createProduct(ctx, {
      sku: "FLOUR",
      nameEn: "Flour",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
      categoryId: dry.id,
    })
  ).id;
  oil = (
    await createProduct(ctx, {
      sku: "OIL",
      nameEn: "Oil",
      type: "RAW_MATERIAL",
      baseUomId: units.l,
      categoryId: oils.id,
    })
  ).id;
  sup.NILE = (await createSupplier(ctx, { code: "NILE", name: "Nile" })).id;
  sup.GLOBAL = (await createSupplier(ctx, { code: "GLOBAL", name: "Global", currency: "USD" })).id;
  await setExchangeRate(ctx, { currency: "USD", rateDate: today, rate: "48" });

  // Nile: flour ordered at 100, charged 110; oil at 20 as ordered.
  nileReceipt = await receive(sup.NILE, [
    { productId: flour, uom: "kg", quantity: "10", ordered: "100", charged: "110" },
    { productId: oil, uom: "l", quantity: "5", ordered: "20", charged: "20" },
  ]);
  // Global: 5 kg flour at 2 USD = 480 EGP at the receipt's rate.
  await receive(sup.GLOBAL, [
    { productId: flour, uom: "kg", quantity: "5", ordered: "2", charged: "2" },
  ]);
  // 2 kg of Nile's flour go back: 220.
  const { id } = await createSupplierReturn(ctx, {
    receiptId: nileReceipt,
    reason: "QUALITY",
    idempotencyKey: `spend-${Date.now()}`,
  });
  const line = (await getSupplierReturn(ctx, id)).returnable.find((r) => r.productId === flour)!;
  await addSupplierReturnLine(ctx, id, {
    receiptLineId: line.id,
    quantity: "2",
    fromStatus: "AVAILABLE",
  });
  await postSupplierReturn(ctx, id);
});

describe("spend report (ADR-095)", () => {
  it("adds received value at each receipt's rate, nets returns, and groups it", async () => {
    const r = await spendReport(ctx, { from: today, to: today });
    expect(r.currency).toBe("EGP");
    expect(r.missingRates).toEqual([]);
    expect([r.total.received, r.total.returned, r.total.net].map((v) => v.toFixed())).toEqual([
      "1680", // 1100 + 100 + 480
      "220",
      "1460",
    ]);
    expect(r.total.variance.toFixed()).toBe("100"); // 10 kg × 10 over the order price
    expect(r.suppliers.map((s) => [s.supplier.code, s.net.toFixed(), s.share!.toFixed(4)])).toEqual(
      [
        ["NILE", "980", "0.6712"],
        ["GLOBAL", "480", "0.3288"],
      ],
    );
    expect(r.top5Share!.toFixed()).toBe("1");
    expect(
      r.categories.map((c) => [c.category?.code, c.net.toFixed(), c.suppliers, c.singleSource]),
    ).toEqual([
      ["DRY", "1360", 2, false],
      ["OIL", "100", 1, true],
    ]);
    expect(r.branches.map((b) => b.branch.code)).toEqual(["CAI"]);
    expect(r.months.map((m) => m.key)).toEqual([today.slice(0, 7)]);
    const csv = await exportSpendCsv(ctx, { from: today, to: today });
    expect(csv).toContain("NILE,Nile,1200.00,220.00,980.00,67.12,2,100.00,EGP");
  });

  it("is in the chosen company's currency, and only for what the user may see", async () => {
    const [company] = await listCompanies(ctx);
    expect(
      (await spendReport(ctx, { from: today, to: today }, company.id)).total.net.toFixed(),
    ).toBe("1460");
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(spendReport(cashier.ctx, { from: today, to: today }), "FORBIDDEN");
    const elsewhere = (await createBranch(ctx, { code: "ALX", name: "Alex", type: "RESTAURANT" }))
      .id;
    const manager = await addMember(ctx, "branch_manager", {
      scopeType: "BRANCH",
      branchId: elsewhere,
    });
    expect((await spendReport(manager.ctx, { from: today, to: today })).total.lines).toBe(0);
    await expectAppError(spendReport(ctx, { from: today, to: "2020-01-01" }), "VALIDATION_FAILED");
  });
});

describe("price variance report (ADR-095)", () => {
  it("shows charged against ordered, and prices against the previous period", async () => {
    let r = await priceVarianceReport(ctx, { from: today, to: today });
    expect([r.total.unfavourable, r.total.favourable, r.total.net].map((v) => v.toFixed())).toEqual(
      ["100", "0", "100"],
    );
    expect(r.total.linesWithVariance).toBe(1);
    expect(
      r.lines.map((l) => [
        l.supplier.code,
        l.product.sku,
        l.orderedUnitPrice.toFixed(),
        l.unitPrice.toFixed(),
      ]),
    ).toEqual([["NILE", "FLOUR", "100", "110"]]);
    const nile = r.suppliers.find((s) => s.supplier.code === "NILE")!;
    expect(nile.rate!.toFixed(4)).toBe("0.0833"); // 100 of 1200
    expect(r.changes).toEqual([]); // nothing bought the day before

    // A delivery the day before at 90/kg: flour now averages (1100 + 480) / 15.
    const earlier = await receive(sup.NILE, [
      { productId: flour, uom: "kg", quantity: "10", ordered: "90", charged: "90" },
    ]);
    await getDb().goodsReceipt.update({
      where: { id: earlier },
      data: { receivedAt: new Date(Date.now() - 86_400_000) },
    });
    r = await priceVarianceReport(ctx, { from: today, to: today });
    const [change] = r.changes;
    expect(change.product.sku).toBe("FLOUR");
    expect(change.before.toFixed()).toBe("90");
    expect(change.now.toDecimalPlaces(4).toFixed()).toBe("105.3333");
    expect(change.impact.toDecimalPlaces(2).toFixed()).toBe("230"); // (105.33 − 90) × 15
    const csv = await exportPriceVarianceCsv(ctx, { from: today, to: today });
    expect(csv.split("\n")[1]).toContain(",NILE,FLOUR,Flour,10,kg,EGP,100,110,100.00,EGP");
  });
});
