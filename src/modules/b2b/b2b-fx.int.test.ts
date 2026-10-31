import { beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { setExchangeRate } from "@/modules/fx/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { createTenant, expectAppError } from "../../../test/support/factories";
import { customerBalances, recordCustomerReceipt } from "./receivables";
import {
  addSalesOrderLine,
  b2bOutputVat,
  confirmSalesOrder,
  createCustomer,
  createSalesOrder,
  deliverSalesOrder,
  getSalesInvoice,
  getSalesOrder,
  invoiceDelivery,
} from "./service";

let ctx: TenantContext;
let today: string;
let gulf: string;
let invoiceId: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("b2b-fx")); // EGP, not VAT registered
  today = businessDate(ctx.timeZone);
  await setExchangeRate(ctx, { currency: "USD", rateDate: addDays(today, -2), rate: "48.5" });
  await setExchangeRate(ctx, { currency: "USD", rateDate: today, rate: "50" });
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (
    await createBranch(ctx, { code: "CK", name: "Kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  const wh = (await createWarehouse(ctx, { branchId, code: "CK", name: "Kitchen", type: "MAIN" }))
    .id;
  const sauce = (
    await createProduct(ctx, {
      sku: "SAUCE",
      nameEn: "Sauce",
      type: "FINISHED_GOOD",
      baseUomId: units.kg,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: wh,
    productId: sauce,
    quantity: "10",
    uomId: units.kg,
    unitCost: "30",
  });
  gulf = (await createCustomer(ctx, { code: "GULF", name: "Gulf Hotels", currency: "USD" })).id;
  const order = await createSalesOrder(ctx, { customerId: gulf, warehouseId: wh });
  await addSalesOrderLine(ctx, order.id, {
    productId: sauce,
    quantity: "4",
    uomId: units.kg,
    unitPrice: "2",
  });
  await confirmSalesOrder(ctx, order.id);
  const so = await getSalesOrder(ctx, order.id);
  expect(so.currency).toBe("USD");
  const d = await deliverSalesOrder(ctx, order.id, {
    lines: [{ lineId: so.lines[0].id, quantity: "4" }],
  });
  invoiceId = (await invoiceDelivery(ctx, d.id, { invoiceDate: addDays(today, -1) })).id;
});

describe("B2B in foreign currencies (ADR-054)", () => {
  it("refuses currencies outside the list", async () => {
    await expectAppError(
      createCustomer(ctx, { code: "UK", name: "UK Ltd", currency: "GBP" }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("invoices in USD at the invoice-date rate with margin in base currency", async () => {
    const inv = await getSalesInvoice(ctx, invoiceId);
    expect(inv.currency).toBe("USD");
    expect(inv.grossAmount.toFixed()).toBe("8");
    expect(inv.exchangeRate.toFixed()).toBe("48.5");
    expect(inv.grossAmountBase.toFixed()).toBe("388");
    expect(inv.cost.toFixed()).toBe("120"); // 4 kg × 30 EGP
    expect(inv.margin.toFixed()).toBe("268"); // 388 − 120
    const vat = await b2bOutputVat(ctx, { from: addDays(today, -1), to: today });
    expect(vat.reduce((a, r) => a + Number(r.net), 0)).toBe(388);
    const b = await customerBalances(ctx, today);
    const row = b.rows.find((r) => r.currency === "USD")!;
    expect([row.balance.toFixed(), row.balanceBase.toFixed(), b.totalBase.toFixed()]).toEqual([
      "8",
      "388",
      "388",
    ]);
  });

  it("collects in USD only against USD invoices and records the realised difference", async () => {
    // An EGP receipt from the same customer cannot settle the USD invoice.
    const egp = await recordCustomerReceipt(ctx, {
      customerId: gulf,
      date: today,
      amount: "100",
      method: "CASH",
      currency: "EGP",
      autoAllocate: "on",
    });
    expect(await getDb().customerReceiptAllocation.count({ where: { receiptId: egp.id } })).toBe(0);
    const usd = await recordCustomerReceipt(ctx, {
      customerId: gulf,
      date: today,
      amount: "8",
      method: "BANK_TRANSFER",
      autoAllocate: "on",
    });
    const r = await getDb().customerReceipt.findUniqueOrThrow({
      where: { id: usd.id },
      include: { allocations: true },
    });
    expect(r.currency).toBe("USD");
    expect(r.amountBase.toFixed()).toBe("400");
    expect(r.allocations[0].fxDifferenceBase.toFixed()).toBe("12"); // 8 × (50 − 48.5): a gain
    const rows = (await customerBalances(ctx, today)).rows;
    expect(rows.find((x) => x.currency === "USD")!.balance.toFixed()).toBe("0");
    const egpRow = rows.find((x) => x.currency === "EGP")!;
    expect([egpRow.unapplied.toFixed(), egpRow.balanceBase.toFixed()]).toEqual(["100", "-100"]);
  });
});
