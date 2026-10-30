import "server-only";
import { Decimal, toDecimal } from "@/lib/decimal";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { loadRules } from "@/modules/procurement/settings";
import { currencyDecimals, taxFromNet } from "@/modules/tax/rules";
import { loadTaxContextInTx } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { paymentStatus } from "./payables-rules";
import { dueDateFor, invoiceMatchStatus, matchGoodsLine, totalMatches } from "./rules";
import {
  chargeLineSchema,
  goodsLineSchema,
  invoiceHeaderSchema,
  invoiceSchema,
  noteSchema,
  reasonSchema,
} from "./schemas";

/**
 * Supplier invoices with a 3-way match (DECISIONS.md ADR-038): goods lines
 * come from posted receipt lines and are matched against the order price
 * (with the organization's tolerance) and the quantity received and not yet
 * invoiced; the printed total must equal the lines. Exceptions are approved
 * by a different person before posting. Needs `invoices.manage`.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);

async function audit(
  tx: Tx,
  ctx: TenantContext,
  inv: { id: string; number: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `supplier_invoice.${action}`,
    entityType: "supplier_invoice",
    entityId: inv.id,
    changes: { number: inv.number, ...changes },
  });
}

/** Serialize invoicing per supplier so receipt quantities are not invoiced twice concurrently. */
export async function lockSupplier(tx: Tx, ctx: TenantContext, supplierId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoices:${ctx.organizationId}:${supplierId}`}))`;
}

async function lockInvoice(
  tx: Tx,
  ctx: TenantContext,
  invoiceId: string,
  opts: { draft?: boolean } = {},
) {
  const found = await tx.supplierInvoice.findFirst({
    where: { organizationId: ctx.organizationId, id: invoiceId },
    select: { supplierId: true },
  });
  if (!found) throw notFound("Invoice");
  await lockSupplier(tx, ctx, found.supplierId);
  const inv = await tx.supplierInvoice.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, id: invoiceId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (opts.draft && inv.status !== "DRAFT")
    throw businessRuleViolation("INVOICE_NOT_DRAFT", "Only draft invoices can change", {
      status: inv.status,
    });
  return inv;
}

/** Quantity (base unit) of each receipt line on invoices that are not cancelled, optionally leaving one out. */
async function invoicedElsewhere(
  tx: Tx,
  ctx: TenantContext,
  receiptLineIds: string[],
  exceptInvoiceId?: string,
) {
  if (receiptLineIds.length === 0) return new Map<string, Decimal>();
  const rows = await tx.supplierInvoiceLine.groupBy({
    by: ["receiptLineId"],
    where: {
      organizationId: ctx.organizationId,
      receiptLineId: { in: receiptLineIds },
      ...(exceptInvoiceId ? { invoiceId: { not: exceptInvoiceId } } : {}),
      invoice: { status: { not: "CANCELLED" } },
    },
    _sum: { quantityBase: true },
  });
  return new Map(rows.map((r) => [r.receiptLineId as string, dec(r._sum.quantityBase ?? 0)]));
}

/** Re-run the match for every line and the totals; any change clears an earlier exception approval. */
async function recompute(tx: Tx, ctx: TenantContext, invoiceId: string) {
  const inv = await tx.supplierInvoice.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, id: invoiceId },
    include: { lines: { include: { receiptLine: true } } },
  });
  const tolerance = (await loadRules(tx, ctx)).invoicePriceTolerance;
  const goods = inv.lines.filter((l) => l.kind === "GOODS");
  const elsewhere = await invoicedElsewhere(
    tx,
    ctx,
    goods.map((l) => l.receiptLineId as string),
    inv.id,
  );
  // Lines of this invoice for the same receipt line share what is open.
  const used = new Map<string, Decimal>();
  const results = [];
  for (const l of inv.lines.sort((a, b) => a.lineNo - b.lineNo)) {
    if (l.kind !== "GOODS" || !l.receiptLine) {
      results.push({
        id: l.id,
        match: "NOT_APPLICABLE" as const,
        quantityVariance: null,
        priceVariance: null,
      });
      continue;
    }
    const rl = l.receiptLineId as string;
    const accepted = dec(l.receiptLine.acceptedQuantityBase);
    const before = (elsewhere.get(rl) ?? new Decimal(0)).plus(used.get(rl) ?? 0);
    const m = matchGoodsLine({
      openBase: Decimal.max(accepted.minus(before), 0),
      invoicedBase: dec(l.quantityBase as Decimal),
      quantity: dec(l.quantity),
      invoicePrice: dec(l.unitPrice),
      orderPrice: dec(l.orderedUnitPrice as Decimal),
      tolerance,
    });
    used.set(rl, (used.get(rl) ?? new Decimal(0)).plus(dec(l.quantityBase as Decimal)));
    results.push({
      id: l.id,
      match: m.match,
      quantityVariance: m.quantityVariance.toFixed(),
      priceVariance: m.priceVariance.toFixed(),
    });
  }
  for (const r of results)
    await tx.supplierInvoiceLine.update({
      where: { id: r.id },
      data: {
        match: r.match,
        quantityVariance: r.quantityVariance,
        priceVariance: r.priceVariance,
      },
    });
  const sum = (pick: (l: (typeof inv.lines)[number]) => Decimal) =>
    inv.lines.reduce((a, l) => a.plus(pick(l)), new Decimal(0));
  const net = sum((l) => dec(l.netAmount));
  const tax = sum((l) => dec(l.taxAmount));
  const gross = sum((l) => dec(l.grossAmount));
  const totalOk = totalMatches(dec(inv.printedGross), gross, currencyDecimals(ctx.baseCurrency));
  const matchStatus = inv.lines.length === 0 ? "MATCHED" : invoiceMatchStatus(results, totalOk);
  const changed =
    matchStatus !== inv.matchStatus ||
    !gross.equals(dec(inv.grossAmount)) ||
    !net.equals(dec(inv.netAmount));
  await tx.supplierInvoice.update({
    where: { id: inv.id },
    data: {
      netAmount: net.toFixed(),
      taxAmount: tax.toFixed(),
      grossAmount: gross.toFixed(),
      matchStatus,
      ...(changed && inv.status === "DRAFT"
        ? { exceptionApprovedAt: null, exceptionApprovedById: null, exceptionNote: null }
        : {}),
    },
  });
  return { matchStatus, totalOk, gross };
}

async function taxFor(
  tx: Tx,
  ctx: TenantContext,
  codeId: string | null | undefined,
  date: string,
  net: Decimal,
  field: string,
) {
  const taxCtx = await loadTaxContextInTx(tx, ctx);
  const resolved = taxCtx.resolvePurchase(codeId, date);
  if (resolved && !resolved.ok)
    throw businessRuleViolation(
      resolved.problem === "noTaxRate" ? "NO_TAX_RATE" : "UNKNOWN_TAX_CODE",
      "VAT code or rate missing",
      {
        field,
        code: resolved.code,
      },
    );
  if (!resolved) return { taxCodeId: null, taxRate: null, net, tax: new Decimal(0), gross: net };
  const t = taxFromNet(net, resolved.rate, ctx.baseCurrency);
  return {
    taxCodeId: resolved.codeId,
    taxRate: resolved.rate.toFixed(),
    net: t.net,
    tax: t.tax,
    gross: t.gross,
  };
}

// ─── Draft ───

export async function createInvoice(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "invoices.manage");
  const parsed = invoiceSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const supplier = await tx.supplier.findFirst({
        where: { organizationId: ctx.organizationId, id: input.supplierId },
      });
      if (!supplier) throw notFound("Supplier");
      const due = input.dueDate ?? dueDateFor(input.invoiceDate, supplier.paymentTermsDays);
      if (due && due < input.invoiceDate)
        throw businessRuleViolation(
          "DUE_BEFORE_INVOICE",
          "The due date is before the invoice date",
          { field: "dueDate" },
        );
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "PI",
        Number(input.invoiceDate.slice(0, 4)),
      );
      const inv = await tx.supplierInvoice.create({
        data: {
          organizationId: ctx.organizationId,
          number,
          supplierId: supplier.id,
          supplierInvoiceNo: input.supplierInvoiceNo,
          invoiceDate: new Date(`${input.invoiceDate}T00:00:00Z`),
          dueDate: due ? new Date(`${due}T00:00:00Z`) : null,
          printedGross: input.printedGross,
          note: input.note,
          createdByUserId: ctx.userId,
        },
        select: { id: true, number: true },
      });
      await audit(tx, ctx, inv, "created", {
        supplierId: supplier.id,
        supplierInvoiceNo: input.supplierInvoiceNo,
      });
      return inv;
    });
  } catch (error) {
    if (isUniqueViolation(error, "supplier_invoices_supplier_number"))
      throw conflict("This supplier invoice number is already entered", {
        reason: "invoiceNumberTaken",
        field: "supplierInvoiceNo",
      });
    throw error;
  }
}

export async function updateInvoiceHeader(
  ctx: TenantContext,
  invoiceId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "invoices.manage");
  const parsed = invoiceHeaderSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const inv = await lockInvoice(tx, ctx, invoiceId, { draft: true });
      if (input.dueDate && input.dueDate < input.invoiceDate)
        throw businessRuleViolation(
          "DUE_BEFORE_INVOICE",
          "The due date is before the invoice date",
          { field: "dueDate" },
        );
      if (inv.lines.length > 0 && input.invoiceDate !== day(inv.invoiceDate))
        throw businessRuleViolation(
          "INVOICE_DATE_LOCKED",
          "Remove the lines to change the invoice date (VAT rates depend on it)",
          {
            field: "invoiceDate",
          },
        );
      await tx.supplierInvoice.update({
        where: { id: inv.id },
        data: {
          supplierInvoiceNo: input.supplierInvoiceNo,
          invoiceDate: new Date(`${input.invoiceDate}T00:00:00Z`),
          dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00Z`) : inv.dueDate,
          printedGross: input.printedGross,
          note: input.note ?? null,
        },
      });
      await recompute(tx, ctx, inv.id);
      await audit(tx, ctx, inv, "updated", input);
    });
  } catch (error) {
    if (isUniqueViolation(error, "supplier_invoices_supplier_number"))
      throw conflict("This supplier invoice number is already entered", {
        reason: "invoiceNumberTaken",
        field: "supplierInvoiceNo",
      });
    throw error;
  }
}

export async function addGoodsLine(ctx: TenantContext, invoiceId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "invoices.manage");
  const parsed = goodsLineSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const inv = await lockInvoice(tx, ctx, invoiceId, { draft: true });
    const rl = await tx.goodsReceiptLine.findFirst({
      where: { organizationId: ctx.organizationId, id: input.receiptLineId },
      include: {
        receipt: { select: { supplierId: true, status: true, number: true } },
        purchaseOrderLine: { select: { id: true, unitPrice: true } },
        product: { select: { id: true, sku: true, nameEn: true, purchaseTaxCodeId: true } },
      },
    });
    if (!rl) throw notFound("Receipt line");
    if (rl.receipt.supplierId !== inv.supplierId)
      throw businessRuleViolation(
        "RECEIPT_OTHER_SUPPLIER",
        "The receipt is from another supplier",
        { field: "receiptLineId" },
      );
    if (rl.receipt.status !== "POSTED")
      throw businessRuleViolation("RECEIPT_ALREADY_REVERSED", "The receipt was reversed", {
        field: "receiptLineId",
      });
    const accepted = dec(rl.acceptedQuantity);
    if (!accepted.gt(0))
      throw businessRuleViolation(
        "RECEIPT_LINE_NOT_ACCEPTED",
        "Nothing was accepted on this receipt line",
        {
          field: "receiptLineId",
        },
      );
    const quantity = toDecimal(input.quantity);
    const quantityBase = quantity
      .times(dec(rl.acceptedQuantityBase))
      .dividedBy(accepted)
      .toDecimalPlaces(6);
    const net = quantity.times(toDecimal(input.unitPrice));
    const t = await taxFor(
      tx,
      ctx,
      input.taxCodeId ?? rl.product.purchaseTaxCodeId,
      day(inv.invoiceDate),
      net,
      "taxCodeId",
    );
    await tx.supplierInvoiceLine.create({
      data: {
        organizationId: ctx.organizationId,
        invoiceId: inv.id,
        lineNo: (inv.lines.at(-1)?.lineNo ?? 0) + 1,
        kind: "GOODS",
        receiptLineId: rl.id,
        purchaseOrderLineId: rl.purchaseOrderLine.id,
        productId: rl.product.id,
        description: `${rl.product.sku} — ${rl.product.nameEn} (${rl.receipt.number})`,
        uomId: rl.uomId,
        quantity: quantity.toFixed(),
        quantityBase: quantityBase.toFixed(),
        unitPrice: input.unitPrice,
        orderedUnitPrice: rl.orderedUnitPrice,
        receivedUnitPrice: rl.unitPrice,
        taxCodeId: t.taxCodeId,
        taxRate: t.taxRate,
        netAmount: t.net.toFixed(),
        taxAmount: t.tax.toFixed(),
        grossAmount: t.gross.toFixed(),
      },
    });
    await recompute(tx, ctx, inv.id);
    await audit(tx, ctx, inv, "line_added", {
      receiptLineId: rl.id,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
    });
  });
}

export async function addChargeLine(ctx: TenantContext, invoiceId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "invoices.manage");
  const parsed = chargeLineSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const inv = await lockInvoice(tx, ctx, invoiceId, { draft: true });
    const net = toDecimal(input.netAmount);
    const t = await taxFor(tx, ctx, input.taxCodeId, day(inv.invoiceDate), net, "taxCodeId");
    await tx.supplierInvoiceLine.create({
      data: {
        organizationId: ctx.organizationId,
        invoiceId: inv.id,
        lineNo: (inv.lines.at(-1)?.lineNo ?? 0) + 1,
        kind: "CHARGE",
        description: input.description,
        quantity: "1",
        unitPrice: input.netAmount,
        taxCodeId: t.taxCodeId,
        taxRate: t.taxRate,
        netAmount: t.net.toFixed(),
        taxAmount: t.tax.toFixed(),
        grossAmount: t.gross.toFixed(),
      },
    });
    await recompute(tx, ctx, inv.id);
    await audit(tx, ctx, inv, "charge_added", input);
  });
}

export async function removeInvoiceLine(ctx: TenantContext, invoiceId: string, lineId: string) {
  assertPermission(ctx.grants, "invoices.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const inv = await lockInvoice(tx, ctx, invoiceId, { draft: true });
    const line = inv.lines.find((l) => l.id === lineId);
    if (!line) throw notFound("Invoice line");
    await tx.supplierInvoiceLine.delete({ where: { id: line.id } });
    await recompute(tx, ctx, inv.id);
    await audit(tx, ctx, inv, "line_removed", { lineNo: line.lineNo });
  });
}

// ─── Approval, posting, cancelling ───

/** Accept the variances of an exception invoice — by someone other than who entered it. */
export async function approveException(ctx: TenantContext, invoiceId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "invoices.manage");
  const parsed = noteSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const inv = await lockInvoice(tx, ctx, invoiceId, { draft: true });
    const { matchStatus } = await recompute(tx, ctx, inv.id);
    if (matchStatus !== "EXCEPTION")
      throw businessRuleViolation(
        "INVOICE_NO_EXCEPTION",
        "The invoice matches; nothing to approve",
      );
    if (inv.createdByUserId === ctx.userId)
      throw businessRuleViolation(
        "INVOICE_SELF_APPROVAL",
        "Someone other than who entered the invoice must approve it",
      );
    await tx.supplierInvoice.update({
      where: { id: inv.id },
      data: {
        exceptionApprovedAt: new Date(),
        exceptionApprovedById: ctx.userId,
        exceptionNote: parsed.data.note,
      },
    });
    await audit(tx, ctx, inv, "exception_approved", { note: parsed.data.note });
  });
}

export async function postInvoice(ctx: TenantContext, invoiceId: string) {
  assertPermission(ctx.grants, "invoices.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const inv = await lockInvoice(tx, ctx, invoiceId, { draft: true });
    if (inv.lines.length === 0)
      throw businessRuleViolation("INVOICE_HAS_NO_LINES", "Add at least one line first");
    const { matchStatus } = await recompute(tx, ctx, inv.id);
    const fresh = await tx.supplierInvoice.findFirstOrThrow({ where: { id: inv.id } });
    if (matchStatus === "EXCEPTION" && !fresh.exceptionApprovedAt)
      throw businessRuleViolation(
        "INVOICE_EXCEPTION_NOT_APPROVED",
        "The invoice does not match; another person must approve the differences first",
      );
    await tx.supplierInvoice.update({
      where: { id: inv.id },
      data: { status: "POSTED", postedAt: new Date(), postedByUserId: ctx.userId },
    });
    await audit(tx, ctx, inv, "posted", { gross: fresh.grossAmount.toFixed(), matchStatus });
  });
}

export async function cancelInvoice(ctx: TenantContext, invoiceId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "invoices.manage");
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const inv = await lockInvoice(tx, ctx, invoiceId);
    if (inv.status === "CANCELLED")
      throw businessRuleViolation("INVOICE_NOT_DRAFT", "Already cancelled", { status: inv.status });
    if ((await settledAmounts(tx, ctx, [inv.id])).get(inv.id)?.gt(0))
      throw businessRuleViolation(
        "INVOICE_HAS_SETTLEMENTS",
        "Payments or credit notes are applied; void them first",
      );
    await tx.supplierInvoice.update({
      where: { id: inv.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledByUserId: ctx.userId,
        cancelReason: parsed.data.reason,
      },
    });
    await audit(tx, ctx, inv, "cancelled", { reason: parsed.data.reason });
  });
}

// ─── Queries ───

/** Amount of each invoice covered by payments and credit notes that are not voided (optionally dated up to `asOf`). */
export async function settledAmounts(
  tx: Tx,
  ctx: TenantContext,
  invoiceIds: string[],
  asOf?: string,
) {
  if (invoiceIds.length === 0) return new Map<string, Decimal>();
  const rows = await tx.settlementAllocation.groupBy({
    by: ["invoiceId"],
    where: {
      organizationId: ctx.organizationId,
      invoiceId: { in: invoiceIds },
      settlement: {
        status: "POSTED",
        ...(asOf ? { date: { lte: new Date(`${asOf}T00:00:00Z`) } } : {}),
      },
    },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.invoiceId, dec(r._sum.amount ?? 0)]));
}

/** Posted receipt lines of a supplier with quantity still to invoice (on any invoice, drafts included). */
export async function uninvoicedReceiptLines(ctx: TenantContext, supplierId: string) {
  assertPermission(ctx.grants, "invoices.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const lines = await tx.goodsReceiptLine.findMany({
      where: {
        organizationId: ctx.organizationId,
        acceptedQuantityBase: { gt: 0 },
        receipt: { supplierId, status: "POSTED" },
      },
      include: {
        receipt: { select: { number: true, receivedAt: true } },
        product: { select: { sku: true, nameEn: true, nameAr: true } },
        uom: { select: { code: true } },
      },
      orderBy: [{ receipt: { receivedAt: "asc" } }, { id: "asc" }],
      take: 300,
    });
    const invoiced = await invoicedElsewhere(
      tx,
      ctx,
      lines.map((l) => l.id),
    );
    return lines
      .map((l) => {
        const acceptedBase = dec(l.acceptedQuantityBase);
        const openBase = Decimal.max(acceptedBase.minus(invoiced.get(l.id) ?? 0), 0);
        const open = openBase
          .times(dec(l.acceptedQuantity))
          .dividedBy(acceptedBase)
          .toDecimalPlaces(6);
        return { ...l, open, openBase };
      })
      .filter((l) => l.openBase.gt(0));
  });
}

export async function listInvoices(
  ctx: TenantContext,
  filters: { status?: "DRAFT" | "POSTED" | "CANCELLED"; supplierId?: string } = {},
) {
  assertPermission(ctx.grants, "invoices.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const invoices = await tx.supplierInvoice.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
      },
      include: { supplier: { select: { code: true, name: true, nameAr: true } } },
      orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
      take: 200,
    });
    const settled = await settledAmounts(
      tx,
      ctx,
      invoices.filter((i) => i.status === "POSTED").map((i) => i.id),
    );
    return invoices.map((i) => {
      const paid = settled.get(i.id) ?? new Decimal(0);
      return {
        ...i,
        settled: paid,
        paymentStatus: i.status === "POSTED" ? paymentStatus(dec(i.grossAmount), paid) : null,
      };
    });
  });
}

export async function getInvoice(ctx: TenantContext, invoiceId: string) {
  assertPermission(ctx.grants, "invoices.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const inv = await tx.supplierInvoice.findFirst({
      where: { organizationId: ctx.organizationId, id: invoiceId },
      include: {
        supplier: { select: { id: true, code: true, name: true, nameAr: true, taxId: true } },
        lines: {
          orderBy: { lineNo: "asc" },
          include: {
            uom: { select: { code: true } },
            taxCode: { select: { code: true } },
            receiptLine: {
              select: { acceptedQuantity: true, receipt: { select: { id: true, number: true } } },
            },
          },
        },
      },
    });
    if (!inv) throw notFound("Invoice");
    const ids = [
      inv.createdByUserId,
      inv.exceptionApprovedById,
      inv.postedByUserId,
      inv.cancelledByUserId,
    ].filter((v): v is string => !!v);
    const users = await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const name = (id: string | null) =>
      id ? (users.find((u) => u.id === id)?.name ?? null) : null;
    const decimals = currencyDecimals(ctx.baseCurrency);
    const manage = hasPermission(ctx.grants, "invoices.manage");
    const draft = inv.status === "DRAFT";
    const settled = (await settledAmounts(tx, ctx, [inv.id])).get(inv.id) ?? new Decimal(0);
    const allocations = await tx.settlementAllocation.findMany({
      where: { organizationId: ctx.organizationId, invoiceId: inv.id },
      include: {
        settlement: { select: { id: true, number: true, kind: true, date: true, status: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return {
      ...inv,
      settled,
      open: Decimal.max(dec(inv.grossAmount).minus(settled), 0),
      paymentStatus: inv.status === "POSTED" ? paymentStatus(dec(inv.grossAmount), settled) : null,
      allocations,
      totalOk: totalMatches(dec(inv.printedGross), dec(inv.grossAmount), decimals),
      names: {
        createdBy: name(inv.createdByUserId),
        approvedBy: name(inv.exceptionApprovedById),
        postedBy: name(inv.postedByUserId),
        cancelledBy: name(inv.cancelledByUserId),
      },
      can: {
        edit: manage && draft,
        approve:
          manage &&
          draft &&
          inv.matchStatus === "EXCEPTION" &&
          !inv.exceptionApprovedAt &&
          inv.createdByUserId !== ctx.userId,
        post:
          manage &&
          draft &&
          inv.lines.length > 0 &&
          (inv.matchStatus === "MATCHED" || !!inv.exceptionApprovedAt),
        cancel: manage && inv.status !== "CANCELLED" && settled.isZero(),
      },
    };
  });
}

/**
 * Input VAT on posted supplier invoices by invoice date, less posted credit
 * notes by their date, per code and rate.
 * `reclaimable` is false when the organization is not VAT registered — the
 * VAT is then part of the cost. An estimate for review, not a return.
 */
export async function inputVatSummary(ctx: TenantContext, period: { from: string; to: string }) {
  assertPermission(ctx.grants, "invoices.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.supplierInvoiceLine.groupBy({
      by: ["taxCodeId", "taxRate"],
      where: {
        organizationId: ctx.organizationId,
        invoice: {
          status: "POSTED",
          invoiceDate: {
            gte: new Date(`${period.from}T00:00:00Z`),
            lte: new Date(`${period.to}T00:00:00Z`),
          },
        },
      },
      _sum: { netAmount: true, taxAmount: true, grossAmount: true },
      _count: { _all: true },
    });
    // Supplier credit notes in the period reduce the input VAT (ADR-039).
    const credits = await tx.supplierSettlement.groupBy({
      by: ["taxCodeId", "taxRate"],
      where: {
        organizationId: ctx.organizationId,
        kind: "CREDIT_NOTE",
        status: "POSTED",
        date: {
          gte: new Date(`${period.from}T00:00:00Z`),
          lte: new Date(`${period.to}T00:00:00Z`),
        },
      },
      _sum: { netAmount: true, taxAmount: true, amount: true },
      _count: { _all: true },
    });
    const codes = await tx.taxCode.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, code: true, name: true, nameAr: true, category: true },
    });
    const settings = await tx.taxSettings.findUnique({
      where: { organizationId: ctx.organizationId },
    });
    const merged = new Map<
      string,
      {
        taxCodeId: string | null;
        rate: Decimal | null;
        lines: number;
        credits: number;
        net: Decimal;
        tax: Decimal;
        gross: Decimal;
      }
    >();
    const keyOf = (codeId: string | null, rate: { toString(): string } | null) =>
      `${codeId ?? ""}|${rate === null ? "" : dec(rate).toFixed()}`;
    const entry = (codeId: string | null, rate: { toString(): string } | null) => {
      const key = keyOf(codeId, rate);
      let e = merged.get(key);
      if (!e) {
        e = {
          taxCodeId: codeId,
          rate: rate === null ? null : dec(rate),
          lines: 0,
          credits: 0,
          net: new Decimal(0),
          tax: new Decimal(0),
          gross: new Decimal(0),
        };
        merged.set(key, e);
      }
      return e;
    };
    for (const r of rows) {
      const e = entry(r.taxCodeId, r.taxRate);
      e.lines += r._count._all;
      e.net = e.net.plus(dec(r._sum.netAmount ?? 0));
      e.tax = e.tax.plus(dec(r._sum.taxAmount ?? 0));
      e.gross = e.gross.plus(dec(r._sum.grossAmount ?? 0));
    }
    for (const c of credits) {
      const e = entry(c.taxCodeId, c.taxRate);
      e.credits += c._count._all;
      e.net = e.net.minus(dec(c._sum.netAmount ?? 0));
      e.tax = e.tax.minus(dec(c._sum.taxAmount ?? 0));
      e.gross = e.gross.minus(dec(c._sum.amount ?? 0));
    }
    return {
      reclaimable: settings?.vatRegistered ?? false,
      rows: [...merged.values()].map((r) => ({
        code: codes.find((c) => c.id === r.taxCodeId) ?? null,
        rate: r.rate,
        lines: r.lines,
        credits: r.credits,
        net: r.net,
        tax: r.tax,
        gross: r.gross,
      })),
    };
  });
}

/** Suppliers and VAT codes for the invoice forms (people entering invoices may not manage suppliers). */
export async function invoiceFormOptions(ctx: TenantContext) {
  assertPermission(ctx.grants, "invoices.manage");
  return withTenantTx(ctx.organizationId, async (tx) => ({
    suppliers: await tx.supplier.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, code: true, name: true, nameAr: true },
      orderBy: { code: "asc" },
      take: 2000,
    }),
    taxCodes: await tx.taxCode.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, code: true, name: true, nameAr: true },
      orderBy: { code: "asc" },
    }),
  }));
}
