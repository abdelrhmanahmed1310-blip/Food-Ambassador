import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { addOrderLine, createOrder, submitOrder } from "@/modules/procurement/orders";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { updateZatcaSettings } from "@/modules/zatca/service";
import { getDb } from "@/server/db/client";
import { renderPdf } from "@/server/pdf/document";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { purchaseOrderForPrint } from "./service";

/** Printable documents (ADR-089). */

let ctx: TenantContext;
let orderId: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("docs-pdf", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  await applyCountryPreset(ctx, "SA");
  const std = (await getTaxSetup(ctx)).codes.find((c) => c.code === "STD")!.id;
  await updateTaxSettings(ctx, {
    country: "SA",
    vatRegistered: "on",
    vatNumber: "310122393500003",
    pricesIncludeTax: "on",
    defaultSalesTaxCodeId: std,
    defaultPurchaseTaxCodeId: std,
  });
  await updateZatcaSettings(ctx, {
    legalName: "Food Ambassador Trading Co",
    crNumber: "1010010000",
    street: "King Fahd Road",
    building: "1234",
    district: "Olaya",
    city: "Riyadh",
    postalCode: "12211",
    businessCategory: "Restaurants",
    environment: "DEVELOPER_PORTAL",
  });
  const kg = (await listUnits(ctx)).find((u) => u.code === "kg")!.id;
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "K", name: "Kitchen", type: "MAIN" })
  ).id;
  const supplierId = (
    await createSupplier(ctx, { code: "OLIVA", name: "Oliva Trading", taxId: "300000000000003" })
  ).id;
  orderId = (await createOrder(ctx, { supplierId, warehouseId })).id;
  for (let i = 1; i <= 45; i++) {
    const p = await createProduct(ctx, {
      sku: `OIL-${i}`,
      nameEn: `Olive oil ${i}`,
      nameAr: "زيت زيتون بكر ممتاز",
      type: "RAW_MATERIAL",
      baseUomId: kg,
    });
    await addOrderLine(ctx, orderId, {
      productId: p.id,
      quantity: "2",
      unitPrice: "12.5",
      uomId: kg,
    });
  }
  await submitOrder(ctx, orderId);
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("printable documents (ADR-089)", () => {
  it("a purchase order carries the company's letterhead and the supplier", async () => {
    const { order, supplier, seller } = await purchaseOrderForPrint(ctx, orderId);
    expect(seller).toMatchObject({
      legalName: "Food Ambassador Trading Co",
      vatNumber: "310122393500003",
      crNumber: "1010010000",
      address: ["1234 King Fahd Road, Olaya", "Riyadh 12211"],
    });
    expect(supplier).toMatchObject({ name: "Oliva Trading", taxId: "300000000000003" });
    expect(order.lines).toHaveLength(45);
  });

  it("renders a multi-page PDF with Arabic names", async () => {
    const { order, seller } = await purchaseOrderForPrint(ctx, orderId);
    const pdf = await renderPdf({
      title: "Purchase order",
      number: order.number,
      seller: {
        name: seller.legalName,
        lines: seller.address,
        facts: [["الرقم الضريبي", seller.vatNumber!]],
      },
      party: { label: "Supplier", name: "Oliva Trading", lines: [] },
      details: [["Currency", order.currency]],
      columns: [
        { label: "#", width: 5 },
        { label: "Item", width: 55 },
        { label: "Amount", width: 40, align: "right" },
      ],
      rows: order.lines.map((l) => [
        String(l.lineNo),
        `${l.product.nameEn}\n${l.product.nameAr}`,
        l.lineTotal.toFixed(2),
      ]),
      totals: [["Total", order.totalAmount.toFixed(2)]],
    });
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    // 45 two-line rows do not fit one A4 page.
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
    // The bundled font is embedded (Arabic glyphs come from it).
    expect(text).toContain("DejaVuSans");
    if (process.env.PDF_SAMPLE)
      (await import("node:fs")).writeFileSync(process.env.PDF_SAMPLE, pdf);
  });

  it("follows the order's permissions", async () => {
    const other = (await createTenant("docs-pdf-other")).ctx;
    await expectAppError(purchaseOrderForPrint(other, orderId), "NOT_FOUND");
    const cashier = (await addMember(ctx, "cashier")).ctx;
    await expectAppError(purchaseOrderForPrint(cashier, orderId), "NOT_FOUND");
  });
});
