import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { findProduct, quantityInBaseUnit } from "@/modules/catalog/service";
import { assertDocumentCurrency, companyContext, currencyConverter } from "@/modules/fx/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { assertSupplierOrderable } from "./compliance";
import {
  addDraftLineInTx,
  canOnWarehouse,
  createDraftOrderInTx,
  loadWarehouseRef,
  recomputeTotal,
  warehouseScope,
} from "./orders";
import {
  awardedQuantity,
  awardNeedsReason,
  lowestOffers,
  rfqActions,
  type Offer,
  type RfqStatus,
} from "./rfq-rules";
import {
  awardRfqSchema,
  createRfqSchema,
  quotationSchema,
  reasonSchema,
  requisitionLineSchema,
  rfqHeaderSchema,
  rfqSupplierSchema,
} from "./schemas";

/**
 * Requests for quotation (DECISIONS.md ADR-092). A buyer lists what to buy
 * for a warehouse and which suppliers to ask, sends it (PDF per supplier),
 * records each supplier's quotation as received, compares the offers in the
 * company's currency, and awards lines: one draft purchase order per chosen
 * supplier at the quoted prices, which then follows the normal approval.
 * Buying from a dearer offer, or one that could not be compared, needs a
 * written reason. Viewing needs `purchasing.view`, everything else
 * `purchasing.manage`, at the RFQ's warehouse.
 */

export const RFQ_PAGE_SIZE = 25;
const dec = (v: { toString(): string }) => new Decimal(v.toString());
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);

type WarehouseRef = Awaited<ReturnType<typeof loadWarehouseRef>>;
const target = (wh: WarehouseRef) => ({ branchId: wh.branchId, warehouseId: wh.id });

async function lockRfq(tx: Tx, ctx: TenantContext, rfqId: string) {
  await tx.$queryRaw`SELECT 1 FROM "rfqs" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${rfqId}::uuid FOR UPDATE`;
  const rfq = await tx.rfq.findFirst({
    where: { organizationId: ctx.organizationId, id: rfqId },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      suppliers: { select: { supplierId: true } },
    },
  });
  if (!rfq) throw notFound("RFQ");
  const wh = await loadWarehouseRef(tx, ctx, rfq.warehouseId);
  if (!canOnWarehouse(ctx, "purchasing.view", wh)) throw notFound("RFQ");
  return { ...rfq, warehouse: wh };
}

type LockedRfq = Awaited<ReturnType<typeof lockRfq>>;

function requireManage(ctx: TenantContext, rfq: LockedRfq) {
  assertPermission(ctx.grants, "purchasing.manage", target(rfq.warehouse));
}

function requireStatus(ok: boolean, status: string) {
  if (!ok)
    throw businessRuleViolation("RFQ_STATUS", "Not possible in the RFQ's status", { status });
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  rfq: { id: string; number: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `rfq.${action}`,
    entityType: "rfq",
    entityId: rfq.id,
    changes: { number: rfq.number, ...changes },
  });
}

// ─── Drafting ───

export async function createRfq(ctx: TenantContext, rawInput: unknown) {
  const parsed = createRfqSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(ctx, { key: idempotencyKey, operation: "rfq.create", input }, async (tx) => {
    const wh = await loadWarehouseRef(tx, ctx, input.warehouseId);
    if (!canOnWarehouse(ctx, "purchasing.view", wh)) throw notFound("Warehouse");
    assertPermission(ctx.grants, "purchasing.manage", target(wh));
    if (wh.archivedAt || wh.branch.archivedAt)
      throw businessRuleViolation("WAREHOUSE_ARCHIVED", "The warehouse is archived");
    const today = businessDate(wh.branch.timeZone ?? ctx.timeZone);
    const number = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      "RFQ",
      Number(today.slice(0, 4)),
    );
    const rfq = await tx.rfq.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        warehouseId: wh.id,
        title: input.title,
        neededBy: input.neededBy ? asDate(input.neededBy) : null,
        respondBy: input.respondBy ? asDate(input.respondBy) : null,
        note: input.note ?? null,
        createdByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    await audit(tx, ctx, rfq, "created", { warehouseId: wh.id, title: input.title });
    return rfq;
  });
}

export async function updateRfqHeader(ctx: TenantContext, rfqId: string, rawInput: unknown) {
  const parsed = rfqHeaderSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const rfq = await lockRfq(tx, ctx, rfqId);
    requireManage(ctx, rfq);
    requireStatus(rfqActions(rfq.status).edit, rfq.status);
    await tx.rfq.update({
      where: { id: rfq.id },
      data: {
        title: v.title,
        neededBy: v.neededBy ? asDate(v.neededBy) : null,
        respondBy: v.respondBy ? asDate(v.respondBy) : null,
        note: v.note ?? null,
      },
    });
    await audit(tx, ctx, rfq, "updated", v);
  });
}

export async function addRfqLine(ctx: TenantContext, rfqId: string, rawInput: unknown) {
  const parsed = requisitionLineSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  assertPermission(ctx.grants, "catalog.view");
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const rfq = await lockRfq(tx, ctx, rfqId);
      requireManage(ctx, rfq);
      requireStatus(rfqActions(rfq.status).edit, rfq.status);
      const product = await findProduct(tx, ctx, v.productId);
      if (product.archivedAt)
        throw businessRuleViolation("PRODUCT_ARCHIVED", "The product is archived");
      // The unit must convert to the product's base unit, as on the order later.
      await quantityInBaseUnit(tx, ctx, product, v.uomId, v.quantity);
      const lineNo = (rfq.lines.at(-1)?.lineNo ?? 0) + 1;
      const line = await tx.rfqLine.create({
        data: {
          organizationId: ctx.organizationId,
          rfqId: rfq.id,
          lineNo,
          productId: product.id,
          uomId: v.uomId,
          quantity: v.quantity,
          note: v.note ?? null,
        },
        select: { id: true },
      });
      await audit(tx, ctx, rfq, "line_added", { lineNo, ...v });
      return line;
    });
  } catch (error) {
    if (isUniqueViolation(error, "rfq_lines_organization_id_rfq_id_product_id_key"))
      throw conflict("This product is already on the RFQ", {
        field: "productId",
        reason: "productOnRfq",
      });
    throw error;
  }
}

export async function removeRfqLine(ctx: TenantContext, rfqId: string, lineId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const rfq = await lockRfq(tx, ctx, rfqId);
    requireManage(ctx, rfq);
    requireStatus(rfqActions(rfq.status).edit, rfq.status);
    const line = rfq.lines.find((l) => l.id === lineId);
    if (!line) throw notFound("RFQ line");
    await tx.rfqLine.delete({ where: { id: line.id } });
    await audit(tx, ctx, rfq, "line_removed", { lineNo: line.lineNo });
  });
}

async function loadInvitable(tx: Tx, ctx: TenantContext, supplierId: string) {
  const supplier = await tx.supplier.findFirst({
    where: { organizationId: ctx.organizationId, id: supplierId },
  });
  if (!supplier) throw notFound("Supplier");
  if (supplier.archivedAt)
    throw businessRuleViolation("SUPPLIER_ARCHIVED", "The supplier is archived", {
      field: "supplierId",
    });
  return supplier;
}

export async function inviteRfqSupplier(ctx: TenantContext, rfqId: string, rawInput: unknown) {
  const parsed = rfqSupplierSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const rfq = await lockRfq(tx, ctx, rfqId);
    requireManage(ctx, rfq);
    requireStatus(rfqActions(rfq.status).edit, rfq.status);
    const supplier = await loadInvitable(tx, ctx, parsed.data.supplierId);
    // A blocked supplier is not asked (ADR-091); one waiting for approval may quote.
    await assertSupplierOrderable(tx, ctx, supplier, "draft", businessDate(ctx.timeZone));
    if (rfq.suppliers.some((s) => s.supplierId === supplier.id))
      throw conflict("This supplier is already asked", {
        field: "supplierId",
        reason: "supplierOnRfq",
      });
    await tx.rfqSupplier.create({
      data: { organizationId: ctx.organizationId, rfqId: rfq.id, supplierId: supplier.id },
    });
    await audit(tx, ctx, rfq, "supplier_added", { supplierId: supplier.id, code: supplier.code });
  });
}

export async function removeRfqSupplier(ctx: TenantContext, rfqId: string, supplierId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const rfq = await lockRfq(tx, ctx, rfqId);
    requireManage(ctx, rfq);
    requireStatus(rfqActions(rfq.status).edit, rfq.status);
    const removed = await tx.rfqSupplier.deleteMany({
      where: { organizationId: ctx.organizationId, rfqId: rfq.id, supplierId },
    });
    if (removed.count === 0) throw notFound("Supplier");
    await audit(tx, ctx, rfq, "supplier_removed", { supplierId });
  });
}

/** Lines and suppliers are fixed from here; the RFQ PDF can go to each supplier. */
export async function sendRfq(ctx: TenantContext, rfqId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const rfq = await lockRfq(tx, ctx, rfqId);
    requireManage(ctx, rfq);
    requireStatus(rfqActions(rfq.status).send, rfq.status);
    if (rfq.lines.length === 0)
      throw businessRuleViolation("RFQ_HAS_NO_LINES", "Add at least one line first");
    if (rfq.suppliers.length === 0)
      throw businessRuleViolation("RFQ_HAS_NO_SUPPLIERS", "Ask at least one supplier first");
    await tx.rfq.update({
      where: { id: rfq.id },
      data: { status: "SENT", sentAt: new Date(), sentByUserId: ctx.userId },
    });
    await audit(tx, ctx, rfq, "sent", { suppliers: rfq.suppliers.length, lines: rfq.lines.length });
  });
}

export async function cancelRfq(ctx: TenantContext, rfqId: string, rawInput: unknown) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const rfq = await lockRfq(tx, ctx, rfqId);
    requireManage(ctx, rfq);
    requireStatus(rfqActions(rfq.status).cancel, rfq.status);
    await tx.rfq.update({
      where: { id: rfq.id },
      data: {
        status: "CANCELLED",
        decidedAt: new Date(),
        decidedByUserId: ctx.userId,
        cancelReason: parsed.data.reason,
      },
    });
    await audit(tx, ctx, rfq, "cancelled", { reason: parsed.data.reason });
  });
}

// ─── Quotations ───

/**
 * Record (or correct) one supplier's quotation as received. Each line is
 * priced per the RFQ line's unit; an empty price means not quoted.
 */
export async function recordQuotation(ctx: TenantContext, rfqId: string, rawInput: unknown) {
  const parsed = quotationSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  if (v.validUntil && v.validUntil < v.quotedOn)
    throw businessRuleViolation("QUOTATION_VALIDITY", "Valid until is before the quotation date", {
      field: "validUntil",
    });
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rfq = await lockRfq(tx, ctx, rfqId);
    requireManage(ctx, rfq);
    requireStatus(rfqActions(rfq.status).record, rfq.status);
    if (!rfq.suppliers.some((s) => s.supplierId === v.supplierId))
      throw businessRuleViolation("SUPPLIER_NOT_ASKED", "This supplier was not asked to quote", {
        field: "supplierId",
      });
    const supplier = await loadInvitable(tx, ctx, v.supplierId);
    const company = await companyContext(tx, ctx, { warehouseId: rfq.warehouseId });
    const currency = v.currency ?? supplier.currency ?? company.currency;
    assertDocumentCurrency(company.ctx, currency);
    const priced = v.lines
      .map((l, index) => ({ ...l, index }))
      .filter((l) => l.unitPrice !== undefined);
    if (priced.length === 0)
      throw businessRuleViolation("QUOTATION_HAS_NO_PRICES", "Enter a price for at least one line");
    for (const l of priced)
      if (!rfq.lines.some((r) => r.id === l.rfqLineId)) throw notFound("RFQ line");
    const header = {
      currency,
      reference: v.reference ?? null,
      quotedOn: asDate(v.quotedOn),
      validUntil: v.validUntil ? asDate(v.validUntil) : null,
      leadTimeDays: v.leadTimeDays ?? null,
      note: v.note ?? null,
    };
    const existing = await tx.quotation.findFirst({
      where: { organizationId: ctx.organizationId, rfqId: rfq.id, supplierId: supplier.id },
      select: { id: true },
    });
    const quotation = existing
      ? await tx.quotation.update({
          where: { id: existing.id },
          data: header,
          select: { id: true },
        })
      : await tx.quotation.create({
          data: {
            ...header,
            organizationId: ctx.organizationId,
            rfqId: rfq.id,
            supplierId: supplier.id,
            createdByUserId: ctx.userId,
          },
          select: { id: true },
        });
    if (existing)
      await tx.quotationLine.deleteMany({
        where: { organizationId: ctx.organizationId, quotationId: quotation.id },
      });
    await tx.quotationLine.createMany({
      data: priced.map((l) => ({
        organizationId: ctx.organizationId,
        quotationId: quotation.id,
        rfqLineId: l.rfqLineId,
        unitPrice: l.unitPrice!,
        quantity: l.quantity ?? null,
        note: l.note ?? null,
      })),
    });
    await audit(tx, ctx, rfq, existing ? "quotation_corrected" : "quotation_recorded", {
      quotationId: quotation.id,
      supplierId: supplier.id,
      currency,
      lines: priced.map((l) => ({
        rfqLineId: l.rfqLineId,
        unitPrice: l.unitPrice,
        quantity: l.quantity,
      })),
    });
    return quotation;
  });
}

// ─── Comparison ───

async function comparison(tx: Tx, ctx: TenantContext, rfq: LockedRfq) {
  const today = businessDate(rfq.warehouse.branch.timeZone ?? ctx.timeZone);
  const company = await companyContext(tx, ctx, { warehouseId: rfq.warehouseId });
  const fx = await currencyConverter(tx, company.ctx, { to: company.currency, date: today });
  const quotations = await tx.quotation.findMany({
    where: { organizationId: ctx.organizationId, rfqId: rfq.id },
    include: {
      lines: true,
      supplier: { select: { id: true, code: true, name: true, nameAr: true, status: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const offersByLine = new Map<
    string,
    Array<Offer & { unitPrice: Decimal; quantity: Decimal | null }>
  >();
  for (const q of quotations) {
    const expired = q.validUntil !== null && day(q.validUntil) < today;
    for (const l of q.lines) {
      const line = rfq.lines.find((r) => r.id === l.rfqLineId)!;
      const amount = dec(l.unitPrice).times(dec(line.quantity));
      offersByLine.set(l.rfqLineId, [
        ...(offersByLine.get(l.rfqLineId) ?? []),
        {
          quotationLineId: l.id,
          quotationId: q.id,
          unitPrice: dec(l.unitPrice),
          quantity: l.quantity === null ? null : dec(l.quantity),
          comparable: await fx.convert(amount, q.currency),
          expired,
        },
      ]);
    }
  }
  return {
    today,
    currency: company.currency,
    quotations,
    offersByLine,
    missingRates: fx.missing(),
  };
}

/** The RFQ page: lines, invited suppliers, quotations and the comparison in the company currency. */
export async function getRfq(ctx: TenantContext, rfqId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rfq = await lockRfq(tx, ctx, rfqId);
    const [lines, suppliers, orders] = await inSequence([
      tx.rfqLine.findMany({
        where: { organizationId: ctx.organizationId, rfqId: rfq.id },
        include: {
          product: { select: { id: true, sku: true, nameEn: true, nameAr: true } },
          uom: { select: { code: true } },
        },
        orderBy: { lineNo: "asc" },
      }),
      tx.rfqSupplier.findMany({
        where: { organizationId: ctx.organizationId, rfqId: rfq.id },
        include: {
          supplier: {
            select: {
              id: true,
              code: true,
              name: true,
              nameAr: true,
              status: true,
              currency: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      tx.purchaseOrder.findMany({
        where: { organizationId: ctx.organizationId, quotation: { rfqId: rfq.id } },
        select: {
          id: true,
          number: true,
          status: true,
          supplierId: true,
          totalAmount: true,
          currency: true,
        },
        orderBy: { number: "asc" },
      }),
    ]);
    const cmp = await comparison(tx, ctx, rfq);
    const warehouse = await tx.warehouse.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, id: rfq.warehouseId },
      select: { id: true, code: true, name: true },
    });
    const rows = lines.map((l) => {
      const offers = cmp.offersByLine.get(l.id) ?? [];
      const lowest = lowestOffers(offers);
      return {
        ...l,
        offers: offers.map((o) => ({
          ...o,
          lowest: lowest.has(o.quotationLineId),
          needsReason: awardNeedsReason(o, offers),
        })),
      };
    });
    // Per quotation: converted total over the lines it quotes in full, and whether it covers all.
    const totals = cmp.quotations.map((q) => {
      let total: Decimal | null = new Decimal(0);
      let complete = true;
      for (const row of rows) {
        const o = row.offers.find((x) => x.quotationId === q.id);
        if (!o || (o.quantity !== null && o.quantity.lessThan(dec(row.quantity)))) complete = false;
        if (o) total = total === null || o.comparable === null ? null : total.plus(o.comparable);
      }
      return { quotationId: q.id, total, complete };
    });
    return {
      rfq: {
        id: rfq.id,
        number: rfq.number,
        title: rfq.title,
        status: rfq.status,
        neededBy: rfq.neededBy,
        respondBy: rfq.respondBy,
        note: rfq.note,
        sentAt: rfq.sentAt,
        decidedAt: rfq.decidedAt,
        cancelReason: rfq.cancelReason,
        createdAt: rfq.createdAt,
        warehouse,
      },
      actions: rfqActions(rfq.status),
      canManage: canOnWarehouse(ctx, "purchasing.manage", rfq.warehouse),
      lines: rows,
      suppliers: suppliers.map((s) => s.supplier),
      quotations: cmp.quotations.map((q) => ({
        id: q.id,
        supplier: q.supplier,
        currency: q.currency,
        reference: q.reference,
        quotedOn: q.quotedOn,
        validUntil: q.validUntil,
        leadTimeDays: q.leadTimeDays,
        note: q.note,
        expired: q.validUntil !== null && day(q.validUntil) < cmp.today,
        lines: q.lines,
        ...totals.find((t) => t.quotationId === q.id)!,
      })),
      currency: cmp.currency,
      missingRates: cmp.missingRates,
      orders,
    };
  });
}

// ─── Award ───

/**
 * Award lines to offers and create one draft purchase order per supplier at
 * the quoted prices (in the quotation's currency). Lines left unawarded are
 * not ordered. The RFQ is then closed as awarded.
 */
export async function awardRfq(ctx: TenantContext, rfqId: string, rawInput: unknown) {
  const parsed = awardRfqSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "rfq.award", input: { rfqId, ...input } },
    async (tx) => {
      const rfq = await lockRfq(tx, ctx, rfqId);
      requireManage(ctx, rfq);
      requireStatus(rfqActions(rfq.status).award, rfq.status);
      const cmp = await comparison(tx, ctx, rfq);
      const chosen = input.lines
        .map((l, index) => ({ ...l, index }))
        .filter((l) => l.quotationLineId !== undefined);
      if (chosen.length === 0)
        throw businessRuleViolation("NOTHING_AWARDED", "Choose an offer for at least one line");
      const byQuotation = new Map<
        string,
        Array<{
          line: (typeof rfq.lines)[number];
          offer: ReturnType<typeof pick>;
          reason: string | null;
        }>
      >();
      function pick(lineId: string, quotationLineId: string, index: number) {
        const offers = cmp.offersByLine.get(lineId) ?? [];
        const offer = offers.find((o) => o.quotationLineId === quotationLineId);
        if (!offer) throw notFound("Offer");
        if (offer.expired)
          throw businessRuleViolation("QUOTATION_EXPIRED", "This quotation is no longer valid", {
            field: `lines.${index}.quotationLineId`,
          });
        return { ...offer, needsReason: awardNeedsReason(offer, offers) };
      }
      for (const c of chosen) {
        const line = rfq.lines.find((l) => l.id === c.rfqLineId);
        if (!line) throw notFound("RFQ line");
        const offer = pick(line.id, c.quotationLineId!, c.index);
        if (offer.needsReason && !c.reason)
          throw businessRuleViolation(
            "AWARD_REASON_REQUIRED",
            "Say why this offer is chosen over a lower or uncompared one",
            { field: `lines.${c.index}.reason` },
          );
        byQuotation.set(offer.quotationId, [
          ...(byQuotation.get(offer.quotationId) ?? []),
          { line, offer, reason: offer.needsReason ? c.reason! : null },
        ]);
      }
      const orders: Array<{ id: string; number: string }> = [];
      for (const [quotationId, awarded] of byQuotation) {
        const q = cmp.quotations.find((x) => x.id === quotationId)!;
        const order = await createDraftOrderInTx(tx, ctx, {
          supplierId: q.supplierId,
          warehouseId: rfq.warehouseId,
          currency: q.currency,
          expectedOn: input.expectedOn,
          note: `RFQ ${rfq.number}${q.reference ? ` / ${q.reference}` : ""}`,
        });
        await tx.purchaseOrder.update({ where: { id: order.id }, data: { quotationId } });
        let lineNo = 0;
        for (const { line, offer, reason } of awarded) {
          await addDraftLineInTx(tx, ctx, order, ++lineNo, {
            productId: line.productId,
            uomId: line.uomId,
            quantity: awardedQuantity(dec(line.quantity), offer.quantity).toFixed(),
            unitPrice: offer.unitPrice.toFixed(),
          });
          await tx.rfqLine.update({
            where: { id: line.id },
            data: { awardedQuotationLineId: offer.quotationLineId, awardReason: reason },
          });
        }
        await recomputeTotal(tx, order.id);
        orders.push(order);
      }
      await tx.rfq.update({
        where: { id: rfq.id },
        data: { status: "AWARDED", decidedAt: new Date(), decidedByUserId: ctx.userId },
      });
      await audit(tx, ctx, rfq, "awarded", {
        orders: orders.map((o) => o.number),
        lines: chosen.map((c) => ({
          rfqLineId: c.rfqLineId,
          quotationLineId: c.quotationLineId,
          reason: c.reason ?? null,
        })),
      });
      return { orders };
    },
  );
}

// ─── Lists and print ───

export async function listRfqs(
  ctx: TenantContext,
  filters: { status?: RfqStatus; page?: number } = {},
) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.RfqWhereInput = {
    organizationId: ctx.organizationId,
    warehouse: warehouseScope(ctx, "purchasing.view"),
    ...(filters.status ? { status: filters.status } : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.rfq.count({ where }),
      tx.rfq.findMany({
        where,
        select: {
          id: true,
          number: true,
          title: true,
          status: true,
          respondBy: true,
          createdAt: true,
          warehouse: { select: { code: true, name: true } },
          _count: { select: { lines: true, suppliers: true, quotations: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * RFQ_PAGE_SIZE,
        take: RFQ_PAGE_SIZE,
      }),
    ]);
    return { items, total, page, pageCount: Math.max(1, Math.ceil(total / RFQ_PAGE_SIZE)) };
  });
}

/** The RFQ as sent to one supplier (PDF). */
export async function rfqForSupplier(ctx: TenantContext, rfqId: string, supplierId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rfq = await lockRfq(tx, ctx, rfqId);
    if (!rfq.suppliers.some((s) => s.supplierId === supplierId)) throw notFound("Supplier");
    const [supplier, lines, warehouse] = await inSequence([
      tx.supplier.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, id: supplierId },
      }),
      tx.rfqLine.findMany({
        where: { organizationId: ctx.organizationId, rfqId: rfq.id },
        include: {
          product: { select: { sku: true, nameEn: true, nameAr: true } },
          uom: { select: { code: true } },
        },
        orderBy: { lineNo: "asc" },
      }),
      tx.warehouse.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, id: rfq.warehouseId },
        select: { code: true, name: true },
      }),
    ]);
    return { rfq, supplier, lines, warehouse };
  });
}
