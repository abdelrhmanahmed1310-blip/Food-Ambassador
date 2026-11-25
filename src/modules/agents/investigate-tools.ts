import "server-only";
import { z } from "zod";
import { accessibleScope, hasPermission } from "@/modules/access/authorize";
import { CONSULTANT_TOOLS } from "@/modules/assistant/consultant-tools";
import { schema, tool, TOOLS as ASSISTANT_TOOLS } from "@/modules/assistant/tools";
import { getInvoice } from "@/modules/invoices/service";
import { withTenantTx } from "@/server/db/transactions";
import { forbidden, notFound } from "@/server/errors";

/**
 * What Claude may read when it investigates a finding (DECISIONS.md
 * ADR-148): the assistant's business tools (ADR-122), dish costs from the
 * food consultant (ADR-131), and two made for exceptions — an invoice's lines
 * against order and receipt, and what a product cost on recent receipts.
 * All read only, as the person who asked, with business fields only: no
 * people, contact details or record ids beyond what a later call needs.
 */

const text = z.string().trim().min(1).max(60);

const invoiceDetail = tool({
  definition: {
    name: "invoice_detail",
    description:
      "One supplier invoice by its number (e.g. PI-2026-000123): supplier, dates, status, match status, the printed and computed totals, and each line with quantity, invoiced price, ordered and received price, match result, quantity and price variance and the receipt it is for.",
    input_schema: schema(
      { invoiceNumber: { type: "string", description: "The app's invoice number." } },
      ["invoiceNumber"],
    ),
    strict: true,
  },
  input: z.object({ invoiceNumber: text }).strict(),
  async run(ctx, i) {
    if (!hasPermission(ctx.grants, "invoices.view")) throw forbidden();
    const row = await withTenantTx(ctx.organizationId, (tx) =>
      tx.supplierInvoice.findFirst({
        where: { organizationId: ctx.organizationId, number: i.invoiceNumber },
        select: { id: true },
      }),
    );
    if (!row) throw notFound("Invoice");
    const inv = await getInvoice(ctx, row.id);
    return {
      data: {
        number: inv.number,
        supplier: inv.supplier.code,
        supplierName: inv.supplier.name,
        supplierInvoiceNo: inv.supplierInvoiceNo,
        invoiceDate: inv.invoiceDate,
        status: inv.status,
        matchStatus: inv.matchStatus,
        currency: inv.currency,
        printedGross: inv.printedGross,
        grossAmount: inv.grossAmount,
        lines: inv.lines.map((l) => ({
          lineNo: l.lineNo,
          kind: l.kind,
          description: l.description,
          quantity: l.quantity,
          unit: l.uom?.code ?? null,
          unitPrice: l.unitPrice,
          orderedUnitPrice: l.orderedUnitPrice,
          receivedUnitPrice: l.receivedUnitPrice,
          match: l.match,
          quantityVariance: l.quantityVariance,
          priceVariance: l.priceVariance,
          receipt: l.receiptLine?.receipt.number ?? null,
          receivedQuantity: l.receiptLine?.acceptedQuantity ?? null,
        })),
      },
      sources: [{ label: `Invoice ${inv.number}`, href: `/purchasing/invoices/${row.id}` }],
    };
  },
});

const supplierPriceHistory = tool({
  definition: {
    name: "supplier_price_history",
    description:
      "What a product (by SKU) cost on its last posted receipts, newest first: receipt number and date, supplier code, unit price and unit, and the order price at the time. Optionally one supplier (by code).",
    input_schema: schema(
      {
        sku: { type: "string", description: "Product SKU." },
        supplier: { type: "string", description: "Optional supplier code." },
      },
      ["sku"],
    ),
    strict: false,
  },
  input: z.object({ sku: text, supplier: text.optional() }).strict(),
  async run(ctx, i) {
    const scope = accessibleScope(ctx.grants, "purchasing.view");
    if (!scope.all && scope.branchIds.length === 0 && scope.warehouseIds.length === 0)
      throw forbidden();
    const lines = await withTenantTx(ctx.organizationId, (tx) =>
      tx.goodsReceiptLine.findMany({
        where: {
          organizationId: ctx.organizationId,
          product: { sku: i.sku },
          receipt: {
            status: "POSTED",
            ...(i.supplier ? { supplier: { code: i.supplier } } : {}),
            ...(scope.all
              ? {}
              : {
                  warehouse: {
                    OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }],
                  },
                }),
          },
        },
        select: {
          unitPrice: true,
          orderedUnitPrice: true,
          uom: { select: { code: true } },
          receipt: {
            select: {
              number: true,
              receivedAt: true,
              currency: true,
              supplier: { select: { code: true } },
            },
          },
        },
        orderBy: { receipt: { receivedAt: "desc" } },
        take: 15,
      }),
    );
    return {
      data: {
        sku: i.sku,
        receipts: lines.map((l) => ({
          receipt: l.receipt.number,
          date: l.receipt.receivedAt.toISOString().slice(0, 10),
          supplier: l.receipt.supplier.code,
          unitPrice: l.unitPrice,
          orderedUnitPrice: l.orderedUnitPrice,
          unit: l.uom.code,
          currency: l.receipt.currency,
        })),
      },
      sources: [{ label: "Purchasing", href: "/purchasing/receipts" }],
    };
  },
});

const dishCosts = CONSULTANT_TOOLS.find((t) => t.definition.name === "dish_costs")!;

export const INVESTIGATION_TOOLS = [
  ...ASSISTANT_TOOLS,
  dishCosts,
  invoiceDetail,
  supplierPriceHistory,
] as const;
