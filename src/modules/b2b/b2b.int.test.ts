import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance, reverseDocument } from "@/modules/inventory/operations";
import { reconcileBalances } from "@/modules/inventory/queries";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { reconcileValuations } from "@/modules/inventory/valuation-queries";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  customerAccount,
  customerBalances,
  recordCustomerReceipt,
  voidCustomerReceipt,
} from "./receivables";
import {
  addSalesOrderLine,
  b2bOutputVat,
  cancelSalesInvoice,
  cancelSalesOrder,
  confirmSalesOrder,
  createCustomer,
  createSalesOrder,
  deliverSalesOrder,
  getSalesInvoice,
  getSalesOrder,
  invoiceDelivery,
  reverseDelivery,
} from "./service";

let ctx: TenantContext;
let units: Record<string, string>;
let ck: string;
let sauce: string;
let customerId: string;
let today: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("b2b"));
  today = businessDate(ctx.timeZone);
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const hq = (
    await createBranch(ctx, { code: "CK", name: "Central kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  ck = (
    await createWarehouse(ctx, { branchId: hq, code: "CK", name: "Central kitchen", type: "MAIN" })
  ).id;
  sauce = (
    await createProduct(ctx, {
      sku: "SAUCE-K",
      nameEn: "Sauce",
      type: "FINISHED_GOOD",
      baseUomId: units.kg,
      lotTracking: "LOT_AND_EXPIRY",
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: ck,
    productId: sauce,
    lotCode: "S-OLD",
    expiresOn: addDays(today, 3),
    quantity: "4",
    uomId: units.kg,
    unitCost: "30",
  });
  await postOpeningBalance(ctx, {
    warehouseId: ck,
    productId: sauce,
    lotCode: "S-NEW",
    expiresOn: addDays(today, 9),
    quantity: "20",
    uomId: units.kg,
    unitCost: "30",
  });
  await applyCountryPreset(ctx, "SA");
  const codes = Object.fromEntries((await getTaxSetup(ctx)).codes.map((c) => [c.code, c.id]));
  await updateTaxSettings(ctx, {
    country: "SA",
    vatRegistered: "on",
    pricesIncludeTax: "on",
    defaultSalesTaxCodeId: codes.STD,
    defaultPurchaseTaxCodeId: codes.STD,
    vatNumber: "310122393500003",
  });
  customerId = (
    await createCustomer(ctx, {
      code: "HOTEL",
      name: "Nile Hotel",
      taxId: "300000000000003",
      paymentTermsDays: "30",
    })
  ).id;
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
  expect(await reconcileValuations(ctx)).toEqual([]);
  await getDb().$disconnect();
});

describe("B2B sales", () => {
  it("orders, delivers FEFO at cost, invoices with VAT and collects", async () => {
    await expectAppError(createCustomer(ctx, { code: "HOTEL", name: "Duplicate" }), "CONFLICT");
    const order = await createSalesOrder(ctx, {
      customerId,
      warehouseId: ck,
      customerRef: "PO-77",
    });
    expect(order.number).toMatch(/^SO-/);
    await expectAppError(confirmSalesOrder(ctx, order.id), "BUSINESS_RULE_VIOLATION");
    // 10 kg at 50.00 net per kg.
    await addSalesOrderLine(ctx, order.id, {
      productId: sauce,
      quantity: "10",
      uomId: units.kg,
      unitPrice: "50",
    });
    await confirmSalesOrder(ctx, order.id);
    await expectAppError(
      addSalesOrderLine(ctx, order.id, {
        productId: sauce,
        quantity: "1",
        uomId: units.kg,
        unitPrice: "50",
      }),
      "BUSINESS_RULE_VIOLATION",
    );

    // Part delivery: 6 kg, oldest lot first.
    const lineId = (await getSalesOrder(ctx, order.id)).lines[0].id;
    await expectAppError(
      deliverSalesOrder(ctx, order.id, { lines: [{ lineId, quantity: "11" }] }),
      "BUSINESS_RULE_VIOLATION",
    );
    const d1 = await deliverSalesOrder(ctx, order.id, { lines: [{ lineId, quantity: "6" }] });
    expect(d1.number).toMatch(/^DN-/);
    let view = await getSalesOrder(ctx, order.id);
    expect([
      view.status,
      view.lines[0].deliveredQuantityBase.toFixed(),
      view.deliveries[0].cost.toFixed(),
    ]).toEqual(["PARTIALLY_DELIVERED", "6", "180"]);
    const lots = await getDb().stockBalance.findMany({
      where: { organizationId: ctx.organizationId, productId: sauce },
      include: { lot: true },
    });
    expect(lots.find((b) => b.lot?.lotCode === "S-OLD")?.onHandQuantity.toFixed()).toBe("0");
    await expectAppError(
      reverseDocument(ctx, view.deliveries[0].document.id, { reasonCode: "ENTERED_IN_ERROR" }),
      "BUSINESS_RULE_VIOLATION",
    );

    // Invoice: 6 × 50 = 300 net + 15 % = 345; due in 30 days; margin 120.
    const inv = await invoiceDelivery(ctx, d1.id, { invoiceDate: today });
    expect(inv.number).toMatch(/^SI-/);
    let i = await getSalesInvoice(ctx, inv.id);
    expect([
      i.netAmount.toFixed(),
      i.taxAmount.toFixed(),
      i.grossAmount.toFixed(),
      i.margin.toFixed(),
    ]).toEqual(["300", "45", "345", "120"]);
    expect(i.dueDate?.toISOString().slice(0, 10)).toBe(addDays(today, 30));
    await expectAppError(invoiceDelivery(ctx, d1.id, { invoiceDate: today }), "CONFLICT");
    await expectAppError(reverseDelivery(ctx, d1.id, { reason: "x" }), "BUSINESS_RULE_VIOLATION");
    const vat = await b2bOutputVat(ctx, { from: today, to: today });
    expect(vat.find((r) => r.code?.code === "STD")?.tax?.toFixed()).toBe("45");

    // The rest is delivered; the order is complete.
    await deliverSalesOrder(ctx, order.id, {});
    view = await getSalesOrder(ctx, order.id);
    expect([view.status, view.deliveries.length]).toEqual(["DELIVERED", 2]);
    await expectAppError(
      cancelSalesOrder(ctx, order.id, { reason: "late" }),
      "BUSINESS_RULE_VIOLATION",
    );

    // Receipt of 200 applied oldest first; balance and aging.
    const r = await recordCustomerReceipt(ctx, {
      customerId,
      date: today,
      amount: "200",
      method: "BANK_TRANSFER",
      autoAllocate: "on",
    });
    i = await getSalesInvoice(ctx, inv.id);
    expect([i.received.toFixed(), i.open.toFixed()]).toEqual(["200", "145"]);
    await expectAppError(
      cancelSalesInvoice(ctx, inv.id, { reason: "x" }),
      "BUSINESS_RULE_VIOLATION",
    );
    let bal = (await customerBalances(ctx)).rows.find((x) => x.customer.id === customerId)!;
    expect([bal.balance.toFixed(), bal.aging.CURRENT.toFixed()]).toEqual(["145", "145"]);
    expect((await customerBalances(ctx, addDays(today, 45))).rows[0].aging.D1_30.toFixed()).toBe(
      "145",
    );
    expect((await customerAccount(ctx, customerId)).open.map((x) => x.open.toFixed())).toEqual([
      "145",
    ]);

    // Void the receipt, cancel the invoice, reverse the delivery: stock back.
    await voidCustomerReceipt(ctx, r.id, { reason: "Bounced" });
    await cancelSalesInvoice(ctx, inv.id, { reason: "Wrong price" });
    await reverseDelivery(ctx, d1.id, { reason: "Returned unopened" });
    view = await getSalesOrder(ctx, order.id);
    expect([view.status, view.lines[0].deliveredQuantityBase.toFixed()]).toEqual([
      "PARTIALLY_DELIVERED",
      "4",
    ]);
    bal = (await customerBalances(ctx)).rows.find((x) => x.customer.id === customerId)!;
    expect(bal?.balance.toFixed() ?? "0").toBe("0");
  });

  it("refuses short deliveries, and keeps posted documents fixed", async () => {
    const order = await createSalesOrder(ctx, { customerId, warehouseId: ck });
    await addSalesOrderLine(ctx, order.id, {
      productId: sauce,
      quantity: "500",
      uomId: units.kg,
      unitPrice: "1",
    });
    await confirmSalesOrder(ctx, order.id);
    await expectAppError(deliverSalesOrder(ctx, order.id, {}), "BUSINESS_RULE_VIOLATION");
    await cancelSalesOrder(ctx, order.id, { reason: "Too much" });
    const inv = (await getDb().salesInvoice.findFirst({
      where: { organizationId: ctx.organizationId },
    }))!;
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.salesInvoice.update({ where: { id: inv.id }, data: { grossAmount: "1" } }),
      ),
    ).rejects.toThrow();
  });

  it("is limited by permission and tenant", async () => {
    const warehouse = (await addMember(ctx, "warehouse")).ctx;
    await expectAppError(createSalesOrder(warehouse, { customerId, warehouseId: ck }), "FORBIDDEN");
    const analyst = (await addMember(ctx, "analyst")).ctx;
    expect((await customerBalances(analyst)).rows.length).toBeGreaterThanOrEqual(0);
    await expectAppError(
      recordCustomerReceipt(analyst, { customerId, date: today, amount: "1", method: "CASH" }),
      "FORBIDDEN",
    );
    const other = await createTenant("b2b-other");
    await expectAppError(createSalesOrder(other.ctx, { customerId, warehouseId: ck }), "NOT_FOUND");
    const anyOrder = (await getDb().salesOrder.findFirst({
      where: { organizationId: ctx.organizationId },
    }))!;
    await expectAppError(getSalesOrder(other.ctx, anyOrder.id), "NOT_FOUND");
  });
});
