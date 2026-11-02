import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { addGoodsLine, createInvoice, uninvoicedReceiptLines } from "@/modules/invoices/service";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { getReceipt, postReceipt } from "@/modules/procurement/receipts";
import { updateProcurementSettings } from "@/modules/procurement/settings";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { createTenant, expectAppError } from "../../../test/support/factories";
import { createCompany, listCompanies } from "./companies";

/** Money documents carry their company (ADR-083). */

let ctx: TenantContext;
let mainCompany: string;
let ksaCompany: string;
let mainWarehouse: string;
let ksaWarehouse: string;
let supplierId: string;
let flour: string;
let kg: string;

async function receive(warehouseId: string) {
  const { id } = await createOrder(ctx, { supplierId, warehouseId });
  await addOrderLine(ctx, id, { productId: flour, quantity: "10", unitPrice: "5", uomId: kg });
  await submitOrder(ctx, id);
  const order = await getOrder(ctx, id);
  const receipt = await postReceipt(ctx, id, {
    lines: order.lines.map((l) => ({
      purchaseOrderLineId: l.id,
      receivedQuantity: l.quantity.toString(),
      unitPrice: "5",
    })),
  });
  return { orderId: id, receipt: await getReceipt(ctx, receipt.id) };
}

beforeAll(async () => {
  ({ ctx } = await createTenant("docs-co"));
  mainCompany = (await listCompanies(ctx))[0].id;
  ksaCompany = (await createCompany(ctx, { code: "KSA", name: "KSA", legalName: "KSA LLC" })).id;
  const mainBranch = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" }))
    .id;
  const ksaBranch = (
    await createBranch(ctx, {
      code: "RUH",
      name: "Riyadh",
      type: "RESTAURANT",
      companyId: ksaCompany,
    })
  ).id;
  mainWarehouse = (
    await createWarehouse(ctx, { branchId: mainBranch, code: "M1", name: "M1", type: "MAIN" })
  ).id;
  ksaWarehouse = (
    await createWarehouse(ctx, { branchId: ksaBranch, code: "K1", name: "K1", type: "MAIN" })
  ).id;
  kg = (await listUnits(ctx)).find((u) => u.code === "kg")!.id;
  flour = (
    await createProduct(ctx, { sku: "FLOUR", nameEn: "Flour", type: "RAW_MATERIAL", baseUomId: kg })
  ).id;
  supplierId = (await createSupplier(ctx, { code: "MILL", name: "Mill" })).id;
  await updateProcurementSettings(ctx, {
    overReceiptTolerancePercent: "0",
    invoicePriceTolerancePercent: "2",
  });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("company on money documents (ADR-083)", () => {
  it("orders and receipts take the company of their warehouse's branch", async () => {
    const ksa = await receive(ksaWarehouse);
    const main = await receive(mainWarehouse);
    const po = (id: string) => getDb().purchaseOrder.findUniqueOrThrow({ where: { id } });
    const gr = (id: string) => getDb().goodsReceipt.findUniqueOrThrow({ where: { id } });
    expect((await po(ksa.orderId)).companyId).toBe(ksaCompany);
    expect((await gr(ksa.receipt.id)).companyId).toBe(ksaCompany);
    expect((await po(main.orderId)).companyId).toBe(mainCompany);
    // The company never changes afterwards.
    await expect(
      getDb().purchaseOrder.update({
        where: { id: ksa.orderId },
        data: { companyId: mainCompany },
      }),
    ).rejects.toThrow();
  });

  it("a supplier invoice bills one company and matches only that company's receipts", async () => {
    const ksaInvoice = await createInvoice(ctx, {
      supplierId,
      supplierInvoiceNo: "INV-K1",
      invoiceDate: "2026-11-01",
      printedGross: "50",
      companyId: ksaCompany,
    });
    const defaultInvoice = await createInvoice(ctx, {
      supplierId,
      supplierInvoiceNo: "INV-M1",
      invoiceDate: "2026-11-01",
      printedGross: "50",
    });
    const row = (id: string) => getDb().supplierInvoice.findUniqueOrThrow({ where: { id } });
    expect((await row(ksaInvoice.id)).companyId).toBe(ksaCompany);
    expect((await row(defaultInvoice.id)).companyId).toBe(mainCompany); // default when not chosen

    const ksaLines = await uninvoicedReceiptLines(ctx, supplierId, ksaCompany);
    const mainLines = await uninvoicedReceiptLines(ctx, supplierId, mainCompany);
    expect(ksaLines).toHaveLength(1);
    expect(mainLines).toHaveLength(1);
    await expectAppError(
      addGoodsLine(ctx, defaultInvoice.id, {
        receiptLineId: ksaLines[0].id,
        quantity: "10",
        unitPrice: "5",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await addGoodsLine(ctx, ksaInvoice.id, {
      receiptLineId: ksaLines[0].id,
      quantity: "10",
      unitPrice: "5",
    });
    await expectAppError(
      createInvoice(ctx, {
        supplierId,
        supplierInvoiceNo: "INV-X",
        invoiceDate: "2026-11-01",
        printedGross: "1",
        companyId: "01900000-0000-7000-8000-000000000000",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("the database refuses a cross-company match even without the service", async () => {
    const mainLine = (await uninvoicedReceiptLines(ctx, supplierId, mainCompany))[0];
    const ksaInvoice = await getDb().supplierInvoice.findFirstOrThrow({
      where: { supplierInvoiceNo: "INV-K1" },
    });
    await expect(
      getDb().$executeRaw`
        INSERT INTO "supplier_invoice_lines"
          ("id", "organization_id", "invoice_id", "line_no", "kind", "receipt_line_id", "description",
           "quantity", "unit_price", "net_amount", "tax_amount", "gross_amount")
        VALUES (gen_random_uuid(), ${ctx.organizationId}::uuid, ${ksaInvoice.id}::uuid, 99, 'GOODS',
                ${mainLine.id}::uuid, 'x', 1, 1, 1, 0, 1)`,
    ).rejects.toThrow(/another company/);
  });
});
