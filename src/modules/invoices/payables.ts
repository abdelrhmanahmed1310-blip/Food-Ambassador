import "server-only";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString, toDecimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { runIdempotent } from "@/modules/shared/idempotency";
import {
  idempotencyKeySchema,
  optionalText,
  optionalUuidSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";
import { currencyDecimals, taxFromNet } from "@/modules/tax/rules";
import { loadTaxContextInTx } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import {
  AGING_BUCKETS,
  agingBucket,
  allocateOldestFirst,
  paymentStatus,
  type AgingBucket,
} from "./payables-rules";
import { lockSupplier, settledAmounts } from "./service";

/**
 * Supplier payables (DECISIONS.md ADR-039): payments and credit notes
 * ("settlements") applied to posted invoices, supplier balances, aging and
 * statements. A settlement is recorded once and can only be voided.
 * Recording needs `payments.manage`; reading needs `invoices.view`.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const zero = () => new Decimal(0);

export const PAYMENT_METHODS = ["BANK_TRANSFER", "CASH", "CHEQUE", "CARD", "OTHER"] as const;

const date = z
  .string({ error: "required" })
  .trim()
  .refine(isCalendarDate, { error: "invalidDate" });
const allocationSchema = z.object({
  invoiceId: uuidSchema,
  amount: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : "0"))
    .pipe(decimalString({ maxScale: 4, min: "0" })),
});
const allocationsSchema = z.object({
  /** "oldest" = apply to the earliest due invoices; otherwise the amounts given per invoice. */
  autoAllocate: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  allocations: z.array(allocationSchema).max(500).optional().default([]),
});

export const paymentSchema = allocationsSchema.extend({
  supplierId: uuidSchema,
  date,
  amount: decimalString({ maxScale: 4, min: "0.0001" }),
  method: z.enum(PAYMENT_METHODS, { error: "invalidOption" }),
  reference: optionalText(80),
  note: optionalText(500),
  idempotencyKey: idempotencyKeySchema,
});

export const creditNoteSchema = allocationsSchema.extend({
  supplierId: uuidSchema,
  supplierDocumentNo: requiredText(60),
  date,
  netAmount: decimalString({ maxScale: 4, min: "0.0001" }),
  taxCodeId: optionalUuidSchema,
  note: requiredText(500),
  idempotencyKey: idempotencyKeySchema,
});

const reasonSchema = z.object({ reason: requiredText(500) });
const asOfSchema = z.string().refine(isCalendarDate, { error: "invalidDate" });

function requireCurrencyUnit(ctx: TenantContext, value: Decimal, field: string) {
  if (value.decimalPlaces() > currencyDecimals(ctx.baseCurrency))
    throw businessRuleViolation("AMOUNT_TOO_PRECISE", "More decimals than the currency has", {
      field,
      decimals: currencyDecimals(ctx.baseCurrency),
    });
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  s: { id: string; number: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `supplier_settlement.${action}`,
    entityType: "supplier_settlement",
    entityId: s.id,
    changes: { number: s.number, ...changes },
  });
}

/** Posted invoices of a supplier with what is still to settle (gross − allocations of posted settlements). */
async function openInvoices(tx: Tx, ctx: TenantContext, supplierId: string) {
  const invoices = await tx.supplierInvoice.findMany({
    where: { organizationId: ctx.organizationId, supplierId, status: "POSTED" },
    select: {
      id: true,
      number: true,
      supplierInvoiceNo: true,
      invoiceDate: true,
      dueDate: true,
      grossAmount: true,
    },
    orderBy: [{ invoiceDate: "asc" }, { number: "asc" }],
  });
  const settled = await settledAmounts(
    tx,
    ctx,
    invoices.map((i) => i.id),
  );
  return invoices.map((i) => {
    const gross = dec(i.grossAmount);
    const paid = settled.get(i.id) ?? zero();
    return {
      ...i,
      dueOn: day(i.dueDate ?? i.invoiceDate),
      settled: paid,
      open: Decimal.max(gross.minus(paid), 0),
      paymentStatus: paymentStatus(gross, paid),
    };
  });
}

/** What a settlement still has to apply. */
async function unappliedOf(
  tx: Tx,
  ctx: TenantContext,
  settlement: { id: string; amount: Decimal },
) {
  const used = await tx.settlementAllocation.aggregate({
    where: { organizationId: ctx.organizationId, settlementId: settlement.id },
    _sum: { amount: true },
  });
  return dec(settlement.amount).minus(dec(used._sum.amount ?? 0));
}

/**
 * Apply up to `available` of a settlement to the supplier's open invoices,
 * explicitly or oldest first. Must run under the supplier lock.
 */
async function applyAllocations(
  tx: Tx,
  ctx: TenantContext,
  settlement: { id: string; supplierId: string },
  available: Decimal,
  input: { autoAllocate: boolean; allocations: Array<{ invoiceId: string; amount: string }> },
) {
  const open = await openInvoices(tx, ctx, settlement.supplierId);
  let planned: Array<{ invoiceId: string; amount: Decimal }>;
  if (input.autoAllocate) {
    planned = allocateOldestFirst(
      available,
      open.map((i) => ({ id: i.id, open: i.open, dueDate: i.dueOn, number: i.number })),
    ).allocations;
  } else {
    planned = [];
    let total = zero();
    for (const [index, a] of input.allocations.entries()) {
      const amount = toDecimal(a.amount);
      if (amount.isZero()) continue;
      const field = `allocations.${index}.amount`;
      requireCurrencyUnit(ctx, amount, field);
      const inv = open.find((i) => i.id === a.invoiceId);
      if (!inv)
        throw businessRuleViolation("INVOICE_NOT_OPEN", "Not a posted invoice of this supplier", {
          field,
        });
      const already = planned
        .filter((p) => p.invoiceId === inv.id)
        .reduce((s, p) => s.plus(p.amount), zero());
      if (amount.plus(already).gt(inv.open))
        throw businessRuleViolation(
          "ALLOCATION_EXCEEDS_INVOICE",
          "More than is open on the invoice",
          { field, open: inv.open.toFixed(), number: inv.number },
        );
      total = total.plus(amount);
      planned.push({ invoiceId: inv.id, amount });
    }
    if (total.gt(available))
      throw businessRuleViolation(
        "ALLOCATION_EXCEEDS_SETTLEMENT",
        "More than the payment or credit note has left",
        { available: available.toFixed() },
      );
  }
  for (const p of planned)
    await tx.settlementAllocation.create({
      data: {
        organizationId: ctx.organizationId,
        settlementId: settlement.id,
        invoiceId: p.invoiceId,
        amount: p.amount.toFixed(),
        createdByUserId: ctx.userId,
      },
    });
  return planned;
}

// ─── Recording ───

export async function recordPayment(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "payments.manage");
  const parsed = paymentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  const amount = toDecimal(input.amount);
  requireCurrencyUnit(ctx, amount, "amount");
  return runIdempotent(
    ctx,
    {
      key: input.idempotencyKey,
      operation: "supplier_payment",
      input: { ...input, idempotencyKey: undefined },
    },
    async (tx) => {
      const supplier = await tx.supplier.findFirst({
        where: { organizationId: ctx.organizationId, id: input.supplierId },
        select: { id: true },
      });
      if (!supplier) throw notFound("Supplier");
      await lockSupplier(tx, ctx, supplier.id);
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "PAY",
        Number(input.date.slice(0, 4)),
      );
      const s = await tx.supplierSettlement.create({
        data: {
          organizationId: ctx.organizationId,
          number,
          kind: "PAYMENT",
          supplierId: supplier.id,
          date: asDate(input.date),
          amount: amount.toFixed(),
          method: input.method,
          reference: input.reference,
          note: input.note,
          createdByUserId: ctx.userId,
        },
        select: { id: true, number: true, supplierId: true },
      });
      const applied = await applyAllocations(tx, ctx, s, amount, input);
      await audit(tx, ctx, s, "payment_recorded", {
        supplierId: supplier.id,
        amount: amount.toFixed(),
        method: input.method,
        allocations: applied.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount.toFixed() })),
      });
      return { id: s.id, number: s.number };
    },
  );
}

export async function recordCreditNote(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "payments.manage");
  const parsed = creditNoteSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  const net = toDecimal(input.netAmount);
  requireCurrencyUnit(ctx, net, "netAmount");
  try {
    return await runIdempotent(
      ctx,
      {
        key: input.idempotencyKey,
        operation: "supplier_credit_note",
        input: { ...input, idempotencyKey: undefined },
      },
      async (tx) => {
        const supplier = await tx.supplier.findFirst({
          where: { organizationId: ctx.organizationId, id: input.supplierId },
          select: { id: true },
        });
        if (!supplier) throw notFound("Supplier");
        await lockSupplier(tx, ctx, supplier.id);
        const taxCtx = await loadTaxContextInTx(tx, ctx);
        const resolved = taxCtx.resolvePurchase(input.taxCodeId, input.date);
        if (resolved && !resolved.ok)
          throw businessRuleViolation(
            resolved.problem === "noTaxRate" ? "NO_TAX_RATE" : "UNKNOWN_TAX_CODE",
            "VAT code or rate missing",
            { field: "taxCodeId", code: resolved.code },
          );
        const t = resolved
          ? taxFromNet(net, resolved.rate, ctx.baseCurrency)
          : { net, tax: zero(), gross: net };
        const number = await nextDocumentNumber(
          tx,
          ctx.organizationId,
          "SCN",
          Number(input.date.slice(0, 4)),
        );
        const s = await tx.supplierSettlement.create({
          data: {
            organizationId: ctx.organizationId,
            number,
            kind: "CREDIT_NOTE",
            supplierId: supplier.id,
            date: asDate(input.date),
            amount: t.gross.toFixed(),
            netAmount: t.net.toFixed(),
            taxAmount: t.tax.toFixed(),
            taxCodeId: resolved ? resolved.codeId : null,
            taxRate: resolved ? resolved.rate.toFixed() : null,
            supplierDocumentNo: input.supplierDocumentNo,
            note: input.note,
            createdByUserId: ctx.userId,
          },
          select: { id: true, number: true, supplierId: true },
        });
        const applied = await applyAllocations(tx, ctx, s, t.gross, input);
        await audit(tx, ctx, s, "credit_note_recorded", {
          supplierId: supplier.id,
          supplierDocumentNo: input.supplierDocumentNo,
          gross: t.gross.toFixed(),
          tax: t.tax.toFixed(),
          allocations: applied.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount.toFixed() })),
        });
        return { id: s.id, number: s.number };
      },
    );
  } catch (error) {
    if (isUniqueViolation(error, "supplier_settlements_credit_note_number"))
      throw conflict("This credit note is already entered", {
        reason: "creditNoteNumberTaken",
        field: "supplierDocumentNo",
      });
    throw error;
  }
}

/** Apply what is left of a payment or credit note to open invoices. */
export async function allocateSettlement(
  ctx: TenantContext,
  settlementId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "payments.manage");
  const parsed = allocationsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const found = await tx.supplierSettlement.findFirst({
      where: { organizationId: ctx.organizationId, id: settlementId },
      select: { supplierId: true },
    });
    if (!found) throw notFound("Settlement");
    await lockSupplier(tx, ctx, found.supplierId);
    const s = await tx.supplierSettlement.findFirstOrThrow({ where: { id: settlementId } });
    if (s.status !== "POSTED")
      throw businessRuleViolation("SETTLEMENT_VOIDED", "The payment or credit note was voided");
    const available = await unappliedOf(tx, ctx, s);
    if (!available.gt(0))
      throw businessRuleViolation("SETTLEMENT_FULLY_APPLIED", "Nothing is left to apply");
    const applied = await applyAllocations(tx, ctx, s, available, parsed.data);
    if (applied.length === 0)
      throw businessRuleViolation(
        "NOTHING_TO_ALLOCATE",
        "Enter an amount for at least one invoice",
      );
    await audit(tx, ctx, s, "allocated", {
      allocations: applied.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount.toFixed() })),
    });
  });
}

/** Void a payment or credit note; its allocations stop counting and the invoices reopen. */
export async function voidSettlement(ctx: TenantContext, settlementId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "payments.manage");
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const found = await tx.supplierSettlement.findFirst({
      where: { organizationId: ctx.organizationId, id: settlementId },
      select: { supplierId: true },
    });
    if (!found) throw notFound("Settlement");
    await lockSupplier(tx, ctx, found.supplierId);
    const s = await tx.supplierSettlement.findFirstOrThrow({ where: { id: settlementId } });
    if (s.status !== "POSTED") throw businessRuleViolation("SETTLEMENT_VOIDED", "Already voided");
    await tx.supplierSettlement.update({
      where: { id: s.id },
      data: {
        status: "VOIDED",
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        voidReason: parsed.data.reason,
      },
    });
    await audit(tx, ctx, s, "voided", { reason: parsed.data.reason });
  });
}

// ─── Queries ───

export type AgingTotals = Record<AgingBucket, Decimal>;
const emptyAging = (): AgingTotals =>
  Object.fromEntries(AGING_BUCKETS.map((b) => [b, zero()])) as AgingTotals;

/**
 * Balance per supplier on `asOf`: posted invoices dated up to then minus
 * posted payments and credit notes dated up to then; open invoice amounts
 * aged by due date; unapplied settlements shown separately. Voids count as
 * of today (a voided settlement never counts).
 */
export async function supplierBalances(ctx: TenantContext, rawAsOf: string) {
  assertPermission(ctx.grants, "invoices.view");
  const asOf = asOfSchema.parse(rawAsOf);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const invoices = await tx.supplierInvoice.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: "POSTED",
        invoiceDate: { lte: asDate(asOf) },
      },
      select: { id: true, supplierId: true, invoiceDate: true, dueDate: true, grossAmount: true },
    });
    const settlements = await tx.supplierSettlement.groupBy({
      by: ["supplierId"],
      where: { organizationId: ctx.organizationId, status: "POSTED", date: { lte: asDate(asOf) } },
      _sum: { amount: true },
    });
    const settled = await settledAmounts(
      tx,
      ctx,
      invoices.map((i) => i.id),
      asOf,
    );
    const supplierIds = [
      ...new Set([...invoices.map((i) => i.supplierId), ...settlements.map((s) => s.supplierId)]),
    ];
    const suppliers = await tx.supplier.findMany({
      where: { organizationId: ctx.organizationId, id: { in: supplierIds } },
      select: { id: true, code: true, name: true, nameAr: true },
    });
    const total = {
      invoiced: zero(),
      settled: zero(),
      balance: zero(),
      unapplied: zero(),
      aging: emptyAging(),
    };
    const rows = suppliers.map((sup) => {
      const own = invoices.filter((i) => i.supplierId === sup.id);
      const aging = emptyAging();
      let invoiced = zero();
      let openTotal = zero();
      for (const i of own) {
        const gross = dec(i.grossAmount);
        invoiced = invoiced.plus(gross);
        const open = Decimal.max(gross.minus(settled.get(i.id) ?? 0), 0);
        if (!open.gt(0)) continue;
        openTotal = openTotal.plus(open);
        const b = agingBucket(day(i.dueDate ?? i.invoiceDate), asOf);
        aging[b] = aging[b].plus(open);
      }
      const paid = dec(settlements.find((s) => s.supplierId === sup.id)?._sum.amount ?? 0);
      const balance = invoiced.minus(paid);
      // Settled amounts not applied to an invoice (on account).
      const unapplied = Decimal.max(openTotal.minus(balance), 0);
      total.invoiced = total.invoiced.plus(invoiced);
      total.settled = total.settled.plus(paid);
      total.balance = total.balance.plus(balance);
      total.unapplied = total.unapplied.plus(unapplied);
      for (const b of AGING_BUCKETS) total.aging[b] = total.aging[b].plus(aging[b]);
      return { supplier: sup, invoiced, settled: paid, balance, unapplied, aging };
    });
    rows.sort(
      (a, b) => b.balance.comparedTo(a.balance) || a.supplier.code.localeCompare(b.supplier.code),
    );
    return { asOf, rows, total };
  });
}

/** A supplier's statement for a period with running balance, plus what is open now. */
export async function supplierStatement(
  ctx: TenantContext,
  supplierId: string,
  period: { from: string; to: string },
) {
  assertPermission(ctx.grants, "invoices.view");
  const from = asOfSchema.parse(period.from);
  const to = asOfSchema.parse(period.to);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const supplier = await tx.supplier.findFirst({
      where: { organizationId: ctx.organizationId, id: supplierId },
      select: {
        id: true,
        code: true,
        name: true,
        nameAr: true,
        taxId: true,
        paymentTermsDays: true,
      },
    });
    if (!supplier) throw notFound("Supplier");
    const before = { lt: asDate(from) };
    const within = { gte: asDate(from), lte: asDate(to) };
    const [invBefore, setBefore, invoices, settlements] = await Promise.all([
      tx.supplierInvoice.aggregate({
        where: {
          organizationId: ctx.organizationId,
          supplierId,
          status: "POSTED",
          invoiceDate: before,
        },
        _sum: { grossAmount: true },
      }),
      tx.supplierSettlement.aggregate({
        where: { organizationId: ctx.organizationId, supplierId, status: "POSTED", date: before },
        _sum: { amount: true },
      }),
      tx.supplierInvoice.findMany({
        where: {
          organizationId: ctx.organizationId,
          supplierId,
          status: "POSTED",
          invoiceDate: within,
        },
        select: {
          id: true,
          number: true,
          supplierInvoiceNo: true,
          invoiceDate: true,
          grossAmount: true,
        },
      }),
      tx.supplierSettlement.findMany({
        where: { organizationId: ctx.organizationId, supplierId, status: "POSTED", date: within },
        select: {
          id: true,
          number: true,
          kind: true,
          date: true,
          amount: true,
          reference: true,
          supplierDocumentNo: true,
        },
      }),
    ]);
    const opening = dec(invBefore._sum.grossAmount ?? 0).minus(dec(setBefore._sum.amount ?? 0));
    const entries = [
      ...invoices.map((i) => ({
        kind: "INVOICE" as const,
        id: i.id,
        number: i.number,
        reference: i.supplierInvoiceNo,
        date: day(i.invoiceDate),
        charge: dec(i.grossAmount),
        credit: zero(),
      })),
      ...settlements.map((s) => ({
        kind: s.kind,
        id: s.id,
        number: s.number,
        reference: s.supplierDocumentNo ?? s.reference,
        date: day(s.date),
        charge: zero(),
        credit: dec(s.amount),
      })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
    let running = opening;
    const lines = entries.map((e) => {
      running = running.plus(e.charge).minus(e.credit);
      return { ...e, balance: running };
    });
    const open = (await openInvoices(tx, ctx, supplierId)).filter((i) => i.open.gt(0));
    const posted = await tx.supplierSettlement.findMany({
      where: { organizationId: ctx.organizationId, supplierId, status: "POSTED" },
      select: { id: true, number: true, kind: true, date: true, amount: true },
      orderBy: { date: "asc" },
    });
    const unapplied = [];
    for (const s of posted) {
      const left = await unappliedOf(tx, ctx, s);
      if (left.gt(0)) unapplied.push({ ...s, unapplied: left });
    }
    return { supplier, from, to, opening, lines, closing: running, open, unapplied };
  });
}

export async function getSettlement(ctx: TenantContext, settlementId: string) {
  assertPermission(ctx.grants, "invoices.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await tx.supplierSettlement.findFirst({
      where: { organizationId: ctx.organizationId, id: settlementId },
      include: {
        supplier: { select: { id: true, code: true, name: true, nameAr: true } },
        taxCode: { select: { code: true } },
        allocations: {
          orderBy: { createdAt: "asc" },
          include: { invoice: { select: { id: true, number: true, supplierInvoiceNo: true } } },
        },
      },
    });
    if (!s) throw notFound("Settlement");
    const users = await tx.user.findMany({
      where: { id: { in: [s.createdByUserId, s.voidedByUserId].filter((v): v is string => !!v) } },
      select: { id: true, name: true },
    });
    const name = (id: string | null) =>
      id ? (users.find((u) => u.id === id)?.name ?? null) : null;
    const applied = s.allocations.reduce((a, x) => a.plus(dec(x.amount)), zero());
    return {
      ...s,
      applied,
      unapplied: s.status === "POSTED" ? dec(s.amount).minus(applied) : zero(),
      names: { createdBy: name(s.createdByUserId), voidedBy: name(s.voidedByUserId) },
    };
  });
}

/** Open invoices of a supplier, for allocation forms. */
export async function openInvoicesOf(ctx: TenantContext, supplierId: string) {
  assertPermission(ctx.grants, "invoices.view");
  return withTenantTx(ctx.organizationId, async (tx) =>
    (await openInvoices(tx, ctx, supplierId)).filter((i) => i.open.gt(0)),
  );
}
