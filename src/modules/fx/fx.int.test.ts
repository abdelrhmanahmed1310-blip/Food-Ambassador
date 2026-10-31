import { beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { Decimal } from "@/lib/decimal";
import { updateApprovalMatrix } from "@/modules/approvals/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import {
  exportPayablesDocumentsCsv,
  exportPayablesJournalCsv,
  updateAccountingSettings,
} from "@/modules/invoices/accounting";
import { recordPayment, supplierBalances } from "@/modules/invoices/payables";
import {
  addChargeLine,
  addGoodsLine,
  createInvoice,
  getInvoice,
  inputVatSummary,
  postInvoice,
} from "@/modules/invoices/service";
import {
  addOrderLine,
  approveOrder,
  createOrder,
  getOrder,
  submitOrder,
} from "@/modules/procurement/orders";
import { postReceipt } from "@/modules/procurement/receipts";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { importExchangeRates, listExchangeRates, setExchangeRate } from "./service";

let ctx: TenantContext;
let wh: string;
let flour: string;
let kg: string;
let acme: string; // USD supplier
let today: string;
let yesterday: string;

const valuation = async () =>
  (
    await getDb().stockValuation.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, productId: flour, warehouseId: wh },
    })
  ).totalValue.toFixed();

async function usdOrder(quantity: string, unitPrice: string) {
  const { id } = await createOrder(ctx, { supplierId: acme, warehouseId: wh });
  await addOrderLine(ctx, id, { productId: flour, uomId: kg, quantity, unitPrice });
  return id;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("fx")); // base currency EGP
  today = businessDate(ctx.timeZone);
  yesterday = addDays(today, -1);
  kg = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id])).kg;
  const branchId = (await createBranch(ctx, { code: "NAS", name: "Nasr City", type: "RESTAURANT" }))
    .id;
  wh = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  flour = (
    await createProduct(ctx, { sku: "FLOUR", nameEn: "Flour", type: "RAW_MATERIAL", baseUomId: kg })
  ).id;
  acme = (await createSupplier(ctx, { code: "ACME", name: "Acme Trading", currency: "USD" })).id;
});

describe("exchange rates (ADR-050)", () => {
  it("are kept per currency and date by people allowed to, with all-or-nothing CSV import", async () => {
    await setExchangeRate(ctx, { currency: "USD", rateDate: addDays(today, -2), rate: "48.5" });
    await setExchangeRate(ctx, { currency: "USD", rateDate: today, rate: "49" });
    await setExchangeRate(ctx, { currency: "USD", rateDate: today, rate: "49" }); // same again: upsert
    await expectAppError(
      setExchangeRate(ctx, { currency: "GBP", rateDate: today, rate: "60" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      setExchangeRate(ctx, { currency: "USD", rateDate: today, rate: "0" }),
      "VALIDATION_FAILED",
    );
    const bad = await importExchangeRates(
      ctx,
      `date,currency,rate\n${today},SAR,12.9\n${today},XXX,1\n`,
    );
    expect(bad.ok).toBe(false);
    expect((await listExchangeRates(ctx)).history.some((h) => h.currency === "SAR")).toBe(false);
    const good = await importExchangeRates(
      ctx,
      `date,currency,rate\n${today},SAR,12.9\n${today},KWD,159.25\n`,
    );
    expect(good).toEqual({ ok: true, imported: 2 });
    const { latest } = await listExchangeRates(ctx);
    expect(latest.find((l) => l.currency === "USD")?.rate?.rate.toFixed()).toBe("49");
    expect(latest.some((l) => l.currency === "EGP")).toBe(false); // the base needs no rate

    const warehouse = (await addMember(ctx, "warehouse")).ctx;
    await expectAppError(
      setExchangeRate(warehouse, { currency: "USD", rateDate: today, rate: "1" }),
      "FORBIDDEN",
    );
    const other = (await createTenant("fx-other")).ctx;
    expect((await listExchangeRates(other)).history).toHaveLength(0);
  });

  it("refuses currencies outside the list and documents without a usable rate", async () => {
    await expectAppError(
      createSupplier(ctx, { code: "UK", name: "UK Foods", currency: "GBP" }),
      "BUSINESS_RULE_VIOLATION",
    );
    const eur = (await createSupplier(ctx, { code: "EURO", name: "Euro Foods", currency: "EUR" }))
      .id;
    const { id } = await createOrder(ctx, { supplierId: eur, warehouseId: wh });
    expect((await getOrder(ctx, id)).currency).toBe("EUR"); // the supplier's currency
    await addOrderLine(ctx, id, { productId: flour, uomId: kg, quantity: "1", unitPrice: "3" });
    await expectAppError(submitOrder(ctx, id), "BUSINESS_RULE_VIOLATION"); // no EUR rate
    await setExchangeRate(ctx, { currency: "EUR", rateDate: addDays(today, -8), rate: "52" });
    const stale = await submitOrder(ctx, id).catch((e) => e);
    expect(stale.details).toMatchObject({ rule: "EXCHANGE_RATE_STALE", currency: "EUR" });
  });
});

describe("a USD purchase from order to payment (ADR-050)", () => {
  let orderId: string;
  let invoiceId: string;

  it("approves by the base-currency total and values stock in base currency", async () => {
    // Head office approves above 1,000 EGP: 25 USD × 49 = 1,225 EGP needs it.
    await updateApprovalMatrix(ctx, "PURCHASE_ORDER", { layer4: "1000" });
    orderId = await usdOrder("10", "2.5");
    expect((await submitOrder(ctx, orderId)).status).toBe("PENDING_APPROVAL");
    let order = await getOrder(ctx, orderId);
    expect(order.exchangeRate?.toFixed()).toBe("49");
    expect(order.totalAmountBase?.toFixed()).toBe("1225");
    await approveOrder((await addMember(ctx, "finance")).ctx, orderId);
    await updateApprovalMatrix(ctx, "PURCHASE_ORDER", {});

    order = await getOrder(ctx, orderId);
    const receipt = await postReceipt(ctx, orderId, {
      lines: [{ purchaseOrderLineId: order.lines[0].id, receivedQuantity: "10", unitPrice: "2.5" }],
    });
    const row = await getDb().goodsReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(row.currency).toBe("USD");
    expect(row.exchangeRate.toFixed()).toBe("49");
    expect(await valuation()).toBe("1225"); // 10 × 2.5 USD × 49
    const link = await getDb().supplierProduct.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, supplierId: acme, productId: flour },
    });
    expect(link.lastUnitPrice?.toFixed()).toBe("2.5"); // kept in the supplier's currency
  });

  it("invoices in USD at the invoice-date rate; receipts in another currency are refused", async () => {
    invoiceId = (
      await createInvoice(ctx, {
        supplierId: acme,
        supplierInvoiceNo: "AC-1",
        invoiceDate: yesterday,
        printedGross: "25",
      })
    ).id;
    const receiptLine = await getDb().goodsReceiptLine.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, receipt: { purchaseOrderId: orderId } },
    });
    const egp = await createInvoice(ctx, {
      supplierId: acme,
      supplierInvoiceNo: "AC-EGP",
      invoiceDate: yesterday,
      printedGross: "1",
      currency: "EGP",
    });
    await expectAppError(
      addGoodsLine(ctx, egp.id, { receiptLineId: receiptLine.id, quantity: "1", unitPrice: "1" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await addGoodsLine(ctx, invoiceId, {
      receiptLineId: receiptLine.id,
      quantity: "10",
      unitPrice: "2.5",
    });
    await postInvoice(ctx, invoiceId);
    const inv = await getInvoice(ctx, invoiceId);
    expect(inv.currency).toBe("USD");
    expect(inv.exchangeRate.toFixed()).toBe("48.5"); // the rate on or before yesterday
    expect(inv.grossAmount.toFixed()).toBe("25");
    expect(inv.grossAmountBase.toFixed()).toBe("1212.5");

    const vat = await inputVatSummary(ctx, { from: yesterday, to: today });
    expect(vat.rows.reduce((a, r) => a.plus(r.gross), new Decimal(0)).toFixed()).toBe("1212.5");

    const balances = await supplierBalances(ctx, today);
    const row = balances.rows.find((r) => r.supplier.code === "ACME" && r.currency === "USD")!;
    expect(row.balance.toFixed()).toBe("25");
    expect(row.balanceBase.toFixed()).toBe("1212.5");
    expect(balances.total.balanceBase.toFixed()).toBe("1212.5");
  });

  it("pays in USD at today's rate and records the realised exchange difference", async () => {
    // A posted EGP invoice of the same supplier cannot be settled by a USD payment.
    const egp = await getDb().supplierInvoice.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, supplierInvoiceNo: "AC-EGP" },
    });
    await addChargeLine(ctx, egp.id, { description: "Handling", netAmount: "1" });
    await postInvoice(ctx, egp.id);
    const refused = await recordPayment(ctx, {
      supplierId: acme,
      date: today,
      amount: "25",
      method: "BANK_TRANSFER",
      allocations: [{ invoiceId: egp.id, amount: "1" }],
    }).catch((e) => e);
    expect(refused.details).toMatchObject({ rule: "INVOICE_NOT_OPEN" });
    await expectAppError(
      recordPayment(ctx, {
        supplierId: acme,
        date: today,
        amount: "25",
        method: "BANK_TRANSFER",
        allocations: [
          {
            invoiceId: (
              await getDb().supplierInvoice.findFirstOrThrow({
                where: { organizationId: ctx.organizationId, supplierInvoiceNo: "AC-EGP" },
              })
            ).id,
            amount: "1",
          },
        ],
      }),
      "BUSINESS_RULE_VIOLATION",
    ); // the same again: nothing was recorded by the refused attempt
    const pay = await recordPayment(ctx, {
      supplierId: acme,
      date: today,
      amount: "25",
      method: "BANK_TRANSFER",
      autoAllocate: "on",
    });
    const s = await getDb().supplierSettlement.findUniqueOrThrow({
      where: { id: pay.id },
      include: { allocations: true },
    });
    expect(s).toMatchObject({ currency: "USD" });
    expect(s.amountBase.toFixed()).toBe("1225");
    expect(s.allocations).toHaveLength(1);
    expect(s.allocations[0].fxDifferenceBase.toFixed()).toBe("12.5"); // 25 × (49 − 48.5): a loss
    const row = (await supplierBalances(ctx, today)).rows.find((r) => r.currency === "USD")!;
    expect(row.balance.toFixed()).toBe("0");
    expect(row.balanceBase.toFixed()).toBe("0");
  });

  it("exports amounts in the document currency with base equivalents and a balanced base journal", async () => {
    const period = { from: yesterday, to: today };
    const docs = parseCsv((await exportPayablesDocumentsCsv(ctx, period)).replace(/^﻿/, ""));
    const header = docs[0];
    const col = (name: string) => header.indexOf(name);
    const inv = docs.find((r) => r[0] === "INVOICE")!;
    expect([
      inv[col("gross")],
      inv[col("currency")],
      inv[col("exchange_rate")],
      inv[col("gross_base")],
    ]).toEqual(["25.00", "USD", "48.5", "1212.50"]);
    const payRow = docs.find((r) => r[0] === "PAYMENT")!;
    expect(payRow[col("gross_base")]).toBe("1225.00");

    await updateAccountingSettings(ctx, {
      payablesAccount: "2100",
      purchasesAccount: "5100",
      paymentsAccount: "1010",
    });
    // A foreign-currency difference needs its own account.
    await expectAppError(exportPayablesJournalCsv(ctx, period), "BUSINESS_RULE_VIOLATION");
    await updateAccountingSettings(ctx, {
      payablesAccount: "2100",
      purchasesAccount: "5100",
      paymentsAccount: "1010",
      fxDifferenceAccount: "7900",
    });
    const journal = parseCsv((await exportPayablesJournalCsv(ctx, period)).replace(/^﻿/, ""));
    const body = journal.slice(1).filter((r) => r.length > 1);
    const sum = (c: number) => body.reduce((a, r) => a.plus(r[c] || "0"), new Decimal(0)).toFixed();
    expect(sum(6)).toBe(sum(7));
    expect(body.every((r) => r[8] === "EGP")).toBe(true);
    const usdInvoice = (await getInvoice(ctx, invoiceId)).number;
    expect(body.filter((r) => r[0] === usdInvoice).map((r) => [r[5], r[6], r[7]])).toEqual([
      ["5100", "1212.50", ""],
      ["2100", "", "1212.50"],
    ]);
    expect(body.filter((r) => r[2] === "PAYMENT").map((r) => [r[5], r[6], r[7]])).toEqual([
      ["2100", "1225.00", ""],
      ["1010", "", "1225.00"],
      ["7900", "12.50", ""],
      ["2100", "", "12.50"],
    ]);
  });
});
