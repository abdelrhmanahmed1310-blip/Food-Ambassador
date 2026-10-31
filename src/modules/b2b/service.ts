import "server-only";
import { emitEvent } from "@/modules/integrations/service";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString, toDecimal } from "@/lib/decimal";
import { uuidv7 } from "@/lib/uuid";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { quantityInBaseUnit } from "@/modules/catalog/service";
import { planConsumptionInTx } from "@/modules/inventory/consumption";
import {
  assertActive,
  loadProductForPosting,
  loadWarehouse,
  todayFor,
} from "@/modules/inventory/context";
import { reverseDocumentInTx } from "@/modules/inventory/operations";
import { nextDocumentNumber, postDocument, type PostingLine } from "@/modules/inventory/posting";
import { dueDateFor } from "@/modules/invoices/rules";
import { runIdempotent } from "@/modules/shared/idempotency";
import {
  codeSchema,
  idempotencyKeySchema,
  optionalText,
  optionalUuidSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";
import { roundToCurrency, taxFromNet } from "@/modules/tax/rules";
import { loadTaxContextInTx } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";

/**
 * B2B sales (DECISIONS.md ADR-047): customers, sales orders, deliveries
 * that take stock FEFO (cost of goods sold), and sales invoices with output
 * VAT at the invoice date. Organization-level `b2b.view` / `b2b.manage`.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const date = (v: string) => new Date(`${v}T00:00:00Z`);
const optionalDate = z
  .string()
  .optional()
  .transform(blank)
  .refine((v) => v === undefined || isCalendarDate(v), { error: "invalidDate" });

async function audit(
  tx: Tx,
  ctx: TenantContext,
  entityType: string,
  entity: { id: string; number?: string; code?: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `${entityType}.${action}`,
    entityType,
    entityId: entity.id,
    changes: {
      ...(entity.number ? { number: entity.number } : {}),
      ...(entity.code ? { code: entity.code } : {}),
      ...changes,
    },
  });
}

// ─── Customers ───

const customerSchema = z.object({
  code: codeSchema,
  name: requiredText(160),
  nameAr: optionalText(160),
  taxId: optionalText(40),
  email: optionalText(200),
  phone: optionalText(40),
  address: optionalText(500),
  paymentTermsDays: z
    .string()
    .optional()
    .transform(blank)
    .refine((v) => v === undefined || (/^\d{1,3}$/.test(v) && Number(v) <= 365), {
      error: "invalidNumber",
    }),
});

export async function createCustomer(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "b2b.manage");
  const parsed = customerSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { paymentTermsDays, ...input } = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const c = await tx.customer.create({
        data: {
          organizationId: ctx.organizationId,
          ...input,
          paymentTermsDays: paymentTermsDays === undefined ? null : Number(paymentTermsDays),
        },
        select: { id: true, code: true },
      });
      await audit(tx, ctx, "customer", c, "created", { name: input.name });
      return c;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("Customer code already used", { reason: "codeTaken", field: "code" });
    throw error;
  }
}

export async function listCustomers(ctx: TenantContext) {
  assertPermission(ctx.grants, "b2b.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.customer.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { code: "asc" },
      take: 2000,
    }),
  );
}

export async function getCustomer(ctx: TenantContext, customerId: string) {
  assertPermission(ctx.grants, "b2b.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.customer.findFirst({
      where: { organizationId: ctx.organizationId, id: customerId },
    });
    if (!c) throw notFound("Customer");
    return c;
  });
}

// ─── Sales orders ───

const orderSchema = z.object({
  customerId: uuidSchema,
  warehouseId: uuidSchema,
  customerRef: optionalText(60),
  requestedOn: optionalDate,
  note: optionalText(500),
  idempotencyKey: idempotencyKeySchema,
});

const orderLineSchema = z.object({
  productId: uuidSchema,
  quantity: decimalString({ maxScale: 6, min: "0.000001" }),
  uomId: uuidSchema,
  unitPrice: decimalString({ maxScale: 6, min: "0" }),
  taxCodeId: optionalUuidSchema,
});

export async function createSalesOrder(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "b2b.manage");
  const parsed = orderSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "sales_order.create", input },
    async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { organizationId: ctx.organizationId, id: input.customerId, archivedAt: null },
        select: { id: true },
      });
      if (!customer) throw notFound("Customer");
      const wh = await loadWarehouse(tx, ctx, input.warehouseId);
      assertActive(wh);
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "SO",
        Number(todayFor(wh).slice(0, 4)),
      );
      const order = await tx.salesOrder.create({
        data: {
          organizationId: ctx.organizationId,
          number,
          customerId: customer.id,
          warehouseId: wh.id,
          customerRef: input.customerRef,
          requestedOn: input.requestedOn ? date(input.requestedOn) : null,
          note: input.note,
          createdByUserId: ctx.userId,
        },
        select: { id: true, number: true },
      });
      await audit(tx, ctx, "sales_order", order, "created", {
        customerId: customer.id,
        warehouseId: wh.id,
      });
      return order;
    },
  );
}

async function lockOrder(tx: Tx, ctx: TenantContext, orderId: string) {
  const found = await tx.salesOrder.findFirst({
    where: { organizationId: ctx.organizationId, id: orderId },
    select: { id: true },
  });
  if (!found) throw notFound("Sales order");
  await tx.$executeRaw`SELECT 1 FROM "sales_orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  return tx.salesOrder.findFirstOrThrow({
    where: { id: orderId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
}

const requireDraft = (status: string) => {
  if (status !== "DRAFT")
    throw businessRuleViolation("SALES_ORDER_NOT_DRAFT", "Only draft orders can change", {
      status,
    });
};

export async function addSalesOrderLine(ctx: TenantContext, orderId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "b2b.manage");
  const parsed = orderLineSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireDraft(order.status);
    const product = await loadProductForPosting(tx, ctx, input.productId);
    if (product.archivedAt)
      throw businessRuleViolation("PRODUCT_ARCHIVED", "The product is archived", {
        field: "productId",
      });
    const quantityBase = await quantityInBaseUnit(tx, ctx, product, input.uomId, input.quantity);
    if (input.taxCodeId) {
      const code = await tx.taxCode.findFirst({
        where: { organizationId: ctx.organizationId, id: input.taxCodeId },
        select: { id: true },
      });
      if (!code) throw notFound("VAT code");
    }
    await tx.salesOrderLine.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: order.id,
        lineNo: (order.lines.at(-1)?.lineNo ?? 0) + 1,
        productId: product.id,
        uomId: input.uomId,
        quantity: input.quantity,
        quantityBase: quantityBase.toFixed(),
        unitPrice: input.unitPrice,
        taxCodeId: input.taxCodeId ?? null,
      },
    });
    await audit(tx, ctx, "sales_order", order, "line_added", {
      productId: product.id,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
    });
  });
}

export async function removeSalesOrderLine(ctx: TenantContext, orderId: string, lineId: string) {
  assertPermission(ctx.grants, "b2b.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireDraft(order.status);
    const line = order.lines.find((l) => l.id === lineId);
    if (!line) throw notFound("Order line");
    await tx.salesOrderLine.delete({ where: { id: line.id } });
    await audit(tx, ctx, "sales_order", order, "line_removed", { lineNo: line.lineNo });
  });
}

export async function confirmSalesOrder(ctx: TenantContext, orderId: string) {
  assertPermission(ctx.grants, "b2b.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireDraft(order.status);
    if (order.lines.length === 0)
      throw businessRuleViolation("SALES_ORDER_EMPTY", "Add at least one line first");
    await tx.salesOrder.update({
      where: { id: order.id },
      data: { status: "CONFIRMED", confirmedAt: new Date(), confirmedByUserId: ctx.userId },
    });
    await audit(tx, ctx, "sales_order", order, "confirmed");
  });
}

export async function cancelSalesOrder(ctx: TenantContext, orderId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "b2b.manage");
  const parsed = z.object({ reason: requiredText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    if (
      !["DRAFT", "CONFIRMED"].includes(order.status) ||
      order.lines.some((l) => dec(l.deliveredQuantityBase).gt(0))
    )
      throw businessRuleViolation(
        "SALES_ORDER_HAS_DELIVERIES",
        "Orders with deliveries cannot be cancelled",
        { status: order.status },
      );
    await tx.salesOrder.update({
      where: { id: order.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: parsed.data.reason },
    });
    await audit(tx, ctx, "sales_order", order, "cancelled", { reason: parsed.data.reason });
  });
}

function statusFromLines(lines: Array<{ quantityBase: Decimal; deliveredQuantityBase: Decimal }>) {
  const delivered = lines.filter((l) => dec(l.deliveredQuantityBase).gt(0));
  if (delivered.length === 0) return "CONFIRMED" as const;
  return lines.every((l) => dec(l.deliveredQuantityBase).gte(dec(l.quantityBase)))
    ? ("DELIVERED" as const)
    : ("PARTIALLY_DELIVERED" as const);
}

const deliverSchema = z.object({
  /** lines.N.lineId / lines.N.quantity (base unit); empty quantity = all that is open. */
  lines: z
    .array(
      z.object({
        lineId: uuidSchema,
        quantity: z
          .string()
          .optional()
          .transform(blank)
          .pipe(decimalString({ maxScale: 6, min: "0" }).optional()),
      }),
    )
    .optional()
    .default([]),
  idempotencyKey: idempotencyKeySchema,
});

/**
 * Deliver what is open (or the quantities given) from the order's warehouse:
 * usable stock FEFO, one CUSTOMER_DELIVERY document, cost of goods recorded
 * per line. Nothing is delivered if any line is short.
 */
export async function deliverSalesOrder(ctx: TenantContext, orderId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "b2b.manage");
  const parsed = deliverSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: `sales_order.deliver:${orderId}`, input },
    async (tx) => {
      const order = await lockOrder(tx, ctx, orderId);
      if (!["CONFIRMED", "PARTIALLY_DELIVERED"].includes(order.status))
        throw businessRuleViolation(
          "SALES_ORDER_NOT_OPEN",
          "Only confirmed orders can be delivered",
          { status: order.status },
        );
      const wh = await loadWarehouse(tx, ctx, order.warehouseId);
      assertActive(wh);
      const wanted = order.lines
        .map((l) => {
          const open = dec(l.quantityBase).minus(dec(l.deliveredQuantityBase));
          const given = input.lines.find((x) => x.lineId === l.id)?.quantity;
          const quantity = given === undefined ? open : toDecimal(given);
          if (quantity.gt(open))
            throw businessRuleViolation("DELIVERY_EXCEEDS_ORDER", "More than is open on the line", {
              lineNo: l.lineNo,
              open: open.toFixed(),
            });
          return { line: l, quantity };
        })
        .filter((w) => w.quantity.gt(0));
      if (wanted.length === 0)
        throw businessRuleViolation("NOTHING_TO_DELIVER", "Nothing is open to deliver");
      // Pick per order line so each line's cost of goods is known.
      const lines: PostingLine[] = [];
      const lineOf: number[] = [];
      const id = uuidv7();
      for (const [index, w] of wanted.entries()) {
        const plan = await planConsumptionInTx(
          tx,
          ctx,
          wh,
          new Map([[w.line.productId, w.quantity]]),
        );
        if (plan.shortages.length > 0) {
          const p = await tx.product.findFirst({
            where: { id: w.line.productId },
            select: { sku: true },
          });
          throw businessRuleViolation(
            "INSUFFICIENT_STOCK_FOR_DELIVERY",
            "Not enough usable stock",
            {
              products: `${p?.sku}: ${plan.shortages[0].available.toFixed()} / ${w.quantity.toFixed()}`,
            },
          );
        }
        for (const pick of plan.picks) {
          lines.push({
            movementType: "CUSTOMER_DELIVERY",
            warehouseId: wh.id,
            locationId: pick.locationId,
            productId: pick.productId,
            lotId: pick.lotId,
            stockStatus: "AVAILABLE",
            quantityDelta: pick.quantity.negated(),
            enteredQuantity: pick.quantity.negated(),
            enteredUomId: pick.uomId,
            reasonCode: "B2B",
            note: order.number,
            postingKey: `delivery:${id}:${index + 1}:${lines.length + 1}`,
          });
          lineOf.push(index);
        }
      }
      const posted = await postDocument(
        tx,
        ctx,
        {
          id,
          type: "CUSTOMER_DELIVERY",
          warehouseId: wh.id,
          reasonCode: "B2B",
          note: order.number,
        },
        lines,
        { year: Number(todayFor(wh).slice(0, 4)), auditChanges: { salesOrder: order.number } },
      );
      const entries = await tx.inventoryLedgerEntry.findMany({
        where: { organizationId: ctx.organizationId, documentId: posted.documentId },
        select: { postingKey: true, valueDelta: true },
      });
      const costByLine = wanted.map(() => new Decimal(0));
      for (const [i, l] of lines.entries()) {
        const e = entries.find((x) => x.postingKey === l.postingKey)!;
        costByLine[lineOf[i]] = costByLine[lineOf[i]].plus(dec(e.valueDelta).negated());
      }
      const cost = costByLine.reduce((a, c) => a.plus(c), new Decimal(0));
      const delivery = await tx.customerDelivery.create({
        data: {
          organizationId: ctx.organizationId,
          // The delivery note carries its stock document's number.
          number: posted.number,
          orderId: order.id,
          documentId: posted.documentId,
          cost: cost.toFixed(),
          deliveredByUserId: ctx.userId,
        },
        select: { id: true, number: true },
      });
      await tx.customerDeliveryLine.createMany({
        data: wanted.map((w, i) => ({
          organizationId: ctx.organizationId,
          deliveryId: delivery.id,
          orderLineId: w.line.id,
          quantityBase: w.quantity.toFixed(),
          cost: costByLine[i].toFixed(),
        })),
      });
      for (const w of wanted)
        await tx.salesOrderLine.update({
          where: { id: w.line.id },
          data: {
            deliveredQuantityBase: dec(w.line.deliveredQuantityBase).plus(w.quantity).toFixed(),
          },
        });
      const fresh = await tx.salesOrderLine.findMany({ where: { orderId: order.id } });
      await tx.salesOrder.update({
        where: { id: order.id },
        data: { status: statusFromLines(fresh) },
      });
      await audit(tx, ctx, "customer_delivery", delivery, "posted", {
        order: order.number,
        cost: cost.toFixed(),
        document: posted.number,
      });
      return delivery;
    },
  );
}

/** Undo a delivery that has no invoice (or only cancelled ones): stock back, order open again. */
export async function reverseDelivery(ctx: TenantContext, deliveryId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "b2b.manage");
  const parsed = z.object({ reason: requiredText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const d = await tx.customerDelivery.findFirst({
      where: { organizationId: ctx.organizationId, id: deliveryId },
      include: { lines: true, invoices: { where: { status: "POSTED" }, select: { id: true } } },
    });
    if (!d) throw notFound("Delivery");
    await lockOrder(tx, ctx, d.orderId);
    if (d.status !== "POSTED") throw businessRuleViolation("DELIVERY_REVERSED", "Already reversed");
    if (d.invoices.length > 0)
      throw businessRuleViolation("DELIVERY_INVOICED", "Cancel the invoice first");
    const reversal = await reverseDocumentInTx(
      tx,
      ctx,
      d.documentId,
      { reasonCode: "ENTERED_IN_ERROR", note: parsed.data.reason },
      { allowReceipt: false, allowDelivery: true, permission: "b2b.manage" },
    );
    await tx.customerDelivery.update({
      where: { id: d.id },
      data: {
        status: "REVERSED",
        reversalDocumentId: reversal.documentId,
        reversedAt: new Date(),
        reversalReason: parsed.data.reason,
      },
    });
    for (const l of d.lines) {
      const ol = await tx.salesOrderLine.findFirstOrThrow({ where: { id: l.orderLineId } });
      await tx.salesOrderLine.update({
        where: { id: ol.id },
        data: {
          deliveredQuantityBase: dec(ol.deliveredQuantityBase).minus(dec(l.quantityBase)).toFixed(),
        },
      });
    }
    const fresh = await tx.salesOrderLine.findMany({ where: { orderId: d.orderId } });
    await tx.salesOrder.update({
      where: { id: d.orderId },
      data: { status: statusFromLines(fresh) },
    });
    await audit(tx, ctx, "customer_delivery", d, "reversed", { reason: parsed.data.reason });
  });
}

// ─── Invoices ───

const invoiceSchema = z.object({
  invoiceDate: z.string().refine(isCalendarDate, { error: "invalidDate" }),
});

/**
 * Invoice a delivery at the order prices: VAT per line at the rate on the
 * invoice date (the line's code or the default sales code), only when the
 * organization is VAT registered; rounded per line (ADR-037).
 */
export async function invoiceDelivery(ctx: TenantContext, deliveryId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "b2b.manage");
  const parsed = invoiceSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const invoiceDate = parsed.data.invoiceDate;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const d = await tx.customerDelivery.findFirst({
        where: { organizationId: ctx.organizationId, id: deliveryId },
        include: {
          order: { include: { customer: true } },
          lines: {
            include: {
              orderLine: {
                include: { product: { select: { id: true, sku: true, nameEn: true } } },
              },
            },
          },
        },
      });
      if (!d) throw notFound("Delivery");
      if (d.status !== "POSTED")
        throw businessRuleViolation("DELIVERY_REVERSED", "The delivery was reversed");
      const taxes = await loadTaxContextInTx(tx, ctx);
      const lines: Array<{
        organizationId: string;
        lineNo: number;
        productId: string;
        description: string;
        quantity: string;
        unitPrice: string;
        taxCodeId: string | null;
        taxRate: string | null;
        netAmount: string;
        taxAmount: string;
        grossAmount: string;
      }> = [];
      for (const [i, l] of d.lines.entries()) {
        const ol = l.orderLine;
        // Price is per order unit; delivered quantity is in base units.
        const perBase = dec(ol.unitPrice).times(dec(ol.quantity)).dividedBy(dec(ol.quantityBase));
        const net = dec(l.quantityBase).times(perBase);
        const resolved = taxes.resolve(ol.taxCodeId, invoiceDate);
        if (resolved && !resolved.ok)
          throw businessRuleViolation(
            resolved.problem === "noTaxRate" ? "NO_TAX_RATE" : "UNKNOWN_TAX_CODE",
            "VAT code or rate missing",
            { code: resolved.code },
          );
        // Not VAT registered (or no VAT in the country): no VAT is charged.
        const t = resolved
          ? taxFromNet(net, resolved.rate, ctx.baseCurrency)
          : (() => {
              const rounded = roundToCurrency(net, ctx.baseCurrency);
              return { net: rounded, tax: new Decimal(0), gross: rounded };
            })();
        lines.push({
          organizationId: ctx.organizationId,
          lineNo: i + 1,
          productId: ol.product.id,
          description: `${ol.product.sku} — ${ol.product.nameEn}`,
          quantity: dec(l.quantityBase).toFixed(),
          unitPrice: perBase.toDecimalPlaces(6).toFixed(),
          taxCodeId: resolved?.codeId ?? null,
          taxRate: resolved ? resolved.rate.toFixed() : null,
          netAmount: t.net.toFixed(),
          taxAmount: t.tax.toFixed(),
          grossAmount: t.gross.toFixed(),
        });
      }
      const sum = (k: "netAmount" | "taxAmount" | "grossAmount") =>
        lines.reduce((a, l) => a.plus(l[k]), new Decimal(0));
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "SI",
        Number(invoiceDate.slice(0, 4)),
      );
      const due = dueDateFor(invoiceDate, d.order.customer.paymentTermsDays);
      const inv = await tx.salesInvoice.create({
        data: {
          organizationId: ctx.organizationId,
          number,
          customerId: d.order.customerId,
          deliveryId: d.id,
          invoiceDate: date(invoiceDate),
          dueDate: due ? date(due) : null,
          netAmount: sum("netAmount").toFixed(),
          taxAmount: sum("taxAmount").toFixed(),
          grossAmount: sum("grossAmount").toFixed(),
          cost: d.cost,
          createdByUserId: ctx.userId,
        },
        select: { id: true, number: true },
      });
      await tx.salesInvoiceLine.createMany({
        data: lines.map((l) => ({ ...l, invoiceId: inv.id })),
      });
      await emitEvent(tx, ctx, "sales_invoice.issued", inv.id, {
        invoiceId: inv.id,
        number: inv.number,
        customerId: d.order.customerId,
        invoiceDate,
        net: sum("netAmount").toFixed(),
        tax: sum("taxAmount").toFixed(),
        gross: sum("grossAmount").toFixed(),
      });
      await audit(tx, ctx, "sales_invoice", inv, "posted", {
        delivery: d.number,
        gross: sum("grossAmount").toFixed(),
      });
      return inv;
    });
  } catch (error) {
    if (isUniqueViolation(error, "sales_invoices_one_per_delivery"))
      throw conflict("This delivery is already invoiced", { reason: "deliveryInvoiced" });
    throw error;
  }
}

export async function cancelSalesInvoice(ctx: TenantContext, invoiceId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "b2b.manage");
  const parsed = z.object({ reason: requiredText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const inv = await tx.salesInvoice.findFirst({
      where: { organizationId: ctx.organizationId, id: invoiceId },
    });
    if (!inv) throw notFound("Invoice");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receivables:${ctx.organizationId}:${inv.customerId}`}))`;
    if (inv.status !== "POSTED")
      throw businessRuleViolation("SALES_INVOICE_CANCELLED", "Already cancelled");
    const paid = await tx.customerReceiptAllocation.count({
      where: {
        organizationId: ctx.organizationId,
        invoiceId: inv.id,
        receipt: { status: "POSTED" },
      },
    });
    if (paid > 0)
      throw businessRuleViolation(
        "SALES_INVOICE_HAS_RECEIPTS",
        "Receipts are applied; void them first",
      );
    await tx.salesInvoice.update({
      where: { id: inv.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledByUserId: ctx.userId,
        cancelReason: parsed.data.reason,
      },
    });
    await audit(tx, ctx, "sales_invoice", inv, "cancelled", { reason: parsed.data.reason });
  });
}

// ─── Queries ───

export async function listSalesOrders(ctx: TenantContext, filters: { customerId?: string } = {}) {
  assertPermission(ctx.grants, "b2b.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.salesOrder.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(filters.customerId ? { customerId: filters.customerId } : {}),
      },
      include: {
        customer: { select: { code: true, name: true, nameAr: true } },
        warehouse: { select: { code: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  );
}

export async function getSalesOrder(ctx: TenantContext, orderId: string) {
  assertPermission(ctx.grants, "b2b.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const order = await tx.salesOrder.findFirst({
      where: { organizationId: ctx.organizationId, id: orderId },
      include: {
        customer: true,
        warehouse: { select: { id: true, code: true, name: true } },
        lines: {
          orderBy: { lineNo: "asc" },
          include: {
            product: {
              select: {
                id: true,
                sku: true,
                nameEn: true,
                nameAr: true,
                baseUom: { select: { code: true } },
              },
            },
            uom: { select: { code: true } },
            taxCode: { select: { code: true } },
          },
        },
        deliveries: {
          orderBy: { deliveredAt: "asc" },
          include: {
            invoices: { select: { id: true, number: true, status: true, grossAmount: true } },
            document: { select: { id: true, number: true } },
          },
        },
      },
    });
    if (!order) throw notFound("Sales order");
    const manage = hasPermission(ctx.grants, "b2b.manage");
    const net = order.lines.reduce(
      (a, l) => a.plus(dec(l.quantity).times(dec(l.unitPrice))),
      new Decimal(0),
    );
    return {
      ...order,
      net,
      can: {
        edit: manage && order.status === "DRAFT",
        confirm: manage && order.status === "DRAFT" && order.lines.length > 0,
        deliver: manage && ["CONFIRMED", "PARTIALLY_DELIVERED"].includes(order.status),
        cancel:
          manage &&
          ["DRAFT", "CONFIRMED"].includes(order.status) &&
          order.lines.every((l) => dec(l.deliveredQuantityBase).isZero()),
        invoice: manage,
      },
    };
  });
}

export async function getSalesInvoice(ctx: TenantContext, invoiceId: string) {
  assertPermission(ctx.grants, "b2b.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const inv = await tx.salesInvoice.findFirst({
      where: { organizationId: ctx.organizationId, id: invoiceId },
      include: {
        customer: true,
        delivery: {
          select: {
            id: true,
            number: true,
            order: { select: { id: true, number: true, customerRef: true } },
          },
        },
        lines: { orderBy: { lineNo: "asc" }, include: { taxCode: { select: { code: true } } } },
        allocations: {
          include: { receipt: { select: { id: true, number: true, date: true, status: true } } },
        },
      },
    });
    if (!inv) throw notFound("Invoice");
    const received = inv.allocations
      .filter((a) => a.receipt.status === "POSTED")
      .reduce((a, x) => a.plus(dec(x.amount)), new Decimal(0));
    return {
      ...inv,
      received,
      open:
        inv.status === "POSTED"
          ? Decimal.max(dec(inv.grossAmount).minus(received), 0)
          : new Decimal(0),
      margin: dec(inv.netAmount).minus(dec(inv.cost)),
      can: {
        cancel:
          hasPermission(ctx.grants, "b2b.manage") && inv.status === "POSTED" && received.isZero(),
      },
    };
  });
}

export async function listSalesInvoices(ctx: TenantContext, filters: { customerId?: string } = {}) {
  assertPermission(ctx.grants, "b2b.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.salesInvoice.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(filters.customerId ? { customerId: filters.customerId } : {}),
      },
      include: { customer: { select: { code: true, name: true, nameAr: true } } },
      orderBy: [{ invoiceDate: "desc" }, { number: "desc" }],
      take: 200,
    }),
  );
}

/** Output VAT on posted B2B invoices by invoice date, per code and rate (for the VAT summary). */
export async function b2bOutputVat(ctx: TenantContext, period: { from: string; to: string }) {
  assertPermission(ctx.grants, "b2b.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.salesInvoiceLine.groupBy({
      by: ["taxCodeId", "taxRate"],
      where: {
        organizationId: ctx.organizationId,
        invoice: {
          status: "POSTED",
          invoiceDate: { gte: date(period.from), lte: date(period.to) },
        },
      },
      _sum: { netAmount: true, taxAmount: true, grossAmount: true },
      _count: { _all: true },
    });
    const codes = await tx.taxCode.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, code: true, name: true, nameAr: true },
    });
    return rows.map((r) => ({
      code: codes.find((c) => c.id === r.taxCodeId) ?? null,
      rate: r.taxRate,
      lines: r._count._all,
      net: r._sum.netAmount,
      tax: r._sum.taxAmount,
      gross: r._sum.grossAmount,
    }));
  });
}
