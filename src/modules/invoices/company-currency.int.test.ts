import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { setExchangeRate } from "@/modules/fx/service";
import { businessDate } from "@/modules/inventory/rules";
import { listValuations } from "@/modules/inventory/valuation-queries";
import { createCompany } from "@/modules/organizations/companies";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { postReceipt } from "@/modules/procurement/receipts";
import { updateProcurementSettings } from "@/modules/procurement/settings";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { createTenant, expectAppError } from "../../../test/support/factories";
import { exportPayablesJournalCsv, updateAccountingSettings } from "./accounting";
import { recordPayment, supplierBalances } from "./payables";
import { previewRevaluation } from "./revaluation";
import {
  addChargeLine,
  addGoodsLine,
  createInvoice,
  getInvoice,
  postInvoice,
  uninvoicedReceiptLines,
} from "./service";

/** Purchasing and payables in a company's own currency (ADR-086, step 3b). */

let ctx: TenantContext;
let egy: string;
let cai: string;
let supplierId: string;
let egpInvoice: string;
const today = () => businessDate(ctx.timeZone);

beforeAll(async () => {
  ({ ctx } = await createTenant("co-pay", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  const kg = (await listUnits(ctx)).find((u) => u.code === "kg")!.id;
  egy = (
    await createCompany(ctx, {
      code: "EGY",
      name: "Egypt",
      legalName: "Egypt Foods",
      currency: "EGP",
    })
  ).id;
  const branchId = (
    await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT", companyId: egy })
  ).id;
  cai = (await createWarehouse(ctx, { branchId, code: "CAI-K", name: "K", type: "MAIN" })).id;
  const flour = (
    await createProduct(ctx, { sku: "FLOUR", nameEn: "Flour", type: "RAW_MATERIAL", baseUomId: kg })
  ).id;
  supplierId = (await createSupplier(ctx, { code: "NILE", name: "Nile Mills" })).id;
  await updateProcurementSettings(ctx, {
    overReceiptTolerancePercent: "0",
    invoicePriceTolerancePercent: "2",
  });
  await setExchangeRate(ctx, { currency: "EGP", rateDate: today(), rate: "0.075" });
  await setExchangeRate(ctx, { currency: "USD", rateDate: today(), rate: "3.75" });

  // An order for the Cairo kitchen: in EGP by default, received into EGP stock.
  const { id } = await createOrder(ctx, { supplierId, warehouseId: cai });
  await addOrderLine(ctx, id, { productId: flour, quantity: "10", unitPrice: "50", uomId: kg });
  await submitOrder(ctx, id);
  const order = await getOrder(ctx, id);
  expect([order.currency, order.totalAmountBase?.toFixed()]).toEqual(["EGP", "500"]);
  await postReceipt(ctx, id, {
    lines: order.lines.map((l) => ({
      purchaseOrderLineId: l.id,
      receivedQuantity: "10",
      unitPrice: "50",
    })),
  });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("purchasing and payables per company currency (ADR-086)", () => {
  it("received stock is valued in the company's currency", async () => {
    const v = await listValuations(ctx, { warehouseId: cai });
    expect([v.currency, v.totalValue.toFixed()]).toEqual(["EGP", "500"]);
  });

  it("supplier invoices are booked in the billed company's currency", async () => {
    egpInvoice = (
      await createInvoice(ctx, {
        supplierId,
        supplierInvoiceNo: "N-1",
        invoiceDate: today(),
        printedGross: "500",
        companyId: egy,
      })
    ).id;
    const line = (await uninvoicedReceiptLines(ctx, supplierId, egy))[0];
    await addGoodsLine(ctx, egpInvoice, {
      receiptLineId: line.id,
      quantity: "10",
      unitPrice: "50",
    });
    await postInvoice(ctx, egpInvoice);
    const inv = await getInvoice(ctx, egpInvoice);
    expect([inv.currency, inv.exchangeRate.toFixed(), inv.netAmountBase.toFixed()]).toEqual([
      "EGP",
      "1",
      "500",
    ]);
    // A USD invoice of the Egyptian company: USD → EGP through the group currency.
    const usd = (
      await createInvoice(ctx, {
        supplierId,
        supplierInvoiceNo: "N-2",
        invoiceDate: today(),
        printedGross: "10",
        currency: "USD",
        companyId: egy,
      })
    ).id;
    await addChargeLine(ctx, usd, { description: "Freight", netAmount: "10" });
    await postInvoice(ctx, usd);
    const u = await getInvoice(ctx, usd);
    expect([u.exchangeRate.toFixed(), u.netAmountBase.toFixed()]).toEqual(["50", "500"]);
  });

  it("balances are kept per company; the group total is converted", async () => {
    const b = await supplierBalances(ctx, today());
    const rows = b.rows.map((r) => [
      r.company.code,
      r.currency,
      r.balance.toFixed(),
      r.baseCurrency,
      r.balanceBase.toFixed(),
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["EGY", "EGP", "500", "EGP", "500"],
        ["EGY", "USD", "10", "EGP", "500"],
      ]),
    );
    expect([b.currency, b.total.balanceBase.toFixed()]).toEqual(["SAR", "75"]); // 1000 EGP × 0.075
  });

  it("a payment settles only its own company's invoices", async () => {
    // The default (Saudi) company cannot pay the Egyptian company's invoice.
    await expectAppError(
      recordPayment(ctx, {
        supplierId,
        date: today(),
        amount: "100",
        method: "BANK_TRANSFER",
        currency: "EGP",
        allocations: [{ invoiceId: egpInvoice, amount: "100" }],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    const pay = await recordPayment(ctx, {
      supplierId,
      companyId: egy,
      date: today(),
      amount: "200",
      method: "BANK_TRANSFER",
      autoAllocate: "on",
    });
    const s = await getDb().supplierSettlement.findUniqueOrThrow({ where: { id: pay.id } });
    expect([s.companyId, s.currency, s.amountBase.toFixed()]).toEqual([egy, "EGP", "200"]);
    // The database refuses a cross-company allocation too.
    const saudi = await recordPayment(ctx, {
      supplierId,
      date: today(),
      amount: "1",
      method: "CASH",
      currency: "EGP",
    });
    await expect(
      getDb().$executeRaw`
        INSERT INTO "settlement_allocations" ("id", "organization_id", "settlement_id", "invoice_id", "amount", "created_by_user_id")
        VALUES (gen_random_uuid(), ${ctx.organizationId}::uuid, ${saudi.id}::uuid, ${egpInvoice}::uuid, 1, ${ctx.userId}::uuid)`,
    ).rejects.toThrow(/another company/);
  });

  it("revaluation is per company, in its currency", async () => {
    await setExchangeRate(ctx, { currency: "USD", rateDate: today(), rate: "4" });
    const egypt = await previewRevaluation(ctx, today(), egy);
    expect(egypt.currency).toBe("EGP");
    // 10 USD booked at 500 EGP, now 10 × 4 / 0.075 = 533.33 EGP.
    expect(
      egypt.lines.map((l) => [l.currency, l.revaluedBase.toFixed(), l.differenceBase.toFixed()]),
    ).toEqual([["USD", "533.33", "33.33"]]);
    const saudi = await previewRevaluation(ctx, today());
    expect(saudi.lines.filter((l) => l.currency === "USD")).toEqual([]);
  });

  it("the journal is one company's, in its currency", async () => {
    await updateAccountingSettings(ctx, {
      payablesAccount: "2100",
      purchasesAccount: "5000",
      paymentsAccount: "1000",
      fxDifferenceAccount: "7900",
    });
    const csv = await exportPayablesJournalCsv(ctx, { from: today(), to: today(), companyId: egy });
    const rows = csv.trim().split("\n").slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.trim().endsWith("EGP"))).toBe(true);
  });
});
