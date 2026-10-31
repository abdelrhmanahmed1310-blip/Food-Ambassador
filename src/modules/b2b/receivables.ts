import "server-only";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString, toDecimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { PAYMENT_METHODS } from "@/modules/invoices/payables";
import {
  AGING_BUCKETS,
  agingBucket,
  allocateOldestFirst,
  paymentStatus,
  type AgingBucket,
} from "@/modules/invoices/payables-rules";
import { runIdempotent } from "@/modules/shared/idempotency";
import {
  idempotencyKeySchema,
  optionalText,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";
import { currencyDecimals } from "@/modules/tax/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";

/**
 * Money owed by B2B customers (DECISIONS.md ADR-047): receipts applied to
 * sales invoices per invoice or earliest due first, voidable; balances and
 * aging by due date. Same rules as supplier payables (ADR-039).
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const zero = () => new Decimal(0);

const receiptSchema = z.object({
  customerId: uuidSchema,
  date: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  amount: decimalString({ maxScale: 4, min: "0.0001" }),
  method: z.enum(PAYMENT_METHODS, { error: "invalidOption" }),
  reference: optionalText(80),
  note: optionalText(500),
  autoAllocate: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  idempotencyKey: idempotencyKeySchema,
});

async function lockCustomer(tx: Tx, ctx: TenantContext, customerId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receivables:${ctx.organizationId}:${customerId}`}))`;
}

async function received(tx: Tx, ctx: TenantContext, invoiceIds: string[], asOf?: string) {
  if (invoiceIds.length === 0) return new Map<string, Decimal>();
  const rows = await tx.customerReceiptAllocation.groupBy({
    by: ["invoiceId"],
    where: {
      organizationId: ctx.organizationId,
      invoiceId: { in: invoiceIds },
      receipt: {
        status: "POSTED",
        ...(asOf ? { date: { lte: new Date(`${asOf}T00:00:00Z`) } } : {}),
      },
    },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.invoiceId, dec(r._sum.amount ?? 0)]));
}

async function openInvoices(tx: Tx, ctx: TenantContext, customerId: string) {
  const invoices = await tx.salesInvoice.findMany({
    where: { organizationId: ctx.organizationId, customerId, status: "POSTED" },
    select: { id: true, number: true, invoiceDate: true, dueDate: true, grossAmount: true },
    orderBy: [{ invoiceDate: "asc" }, { number: "asc" }],
  });
  const paid = await received(
    tx,
    ctx,
    invoices.map((i) => i.id),
  );
  return invoices.map((i) => {
    const got = paid.get(i.id) ?? zero();
    return {
      ...i,
      dueOn: day(i.dueDate ?? i.invoiceDate),
      received: got,
      open: Decimal.max(dec(i.grossAmount).minus(got), 0),
      paymentStatus: paymentStatus(dec(i.grossAmount), got),
    };
  });
}

export async function recordCustomerReceipt(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "b2b.manage");
  const parsed = receiptSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  const amount = toDecimal(input.amount);
  if (amount.decimalPlaces() > currencyDecimals(ctx.baseCurrency))
    throw businessRuleViolation("AMOUNT_TOO_PRECISE", "More decimals than the currency has", {
      field: "amount",
      decimals: currencyDecimals(ctx.baseCurrency),
    });
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "customer_receipt", input },
    async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { organizationId: ctx.organizationId, id: input.customerId },
        select: { id: true },
      });
      if (!customer) throw notFound("Customer");
      await lockCustomer(tx, ctx, customer.id);
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "RCT",
        Number(input.date.slice(0, 4)),
      );
      const r = await tx.customerReceipt.create({
        data: {
          organizationId: ctx.organizationId,
          number,
          customerId: customer.id,
          date: new Date(`${input.date}T00:00:00Z`),
          amount: amount.toFixed(),
          method: input.method,
          reference: input.reference,
          note: input.note,
          createdByUserId: ctx.userId,
        },
        select: { id: true, number: true },
      });
      const applied = input.autoAllocate
        ? allocateOldestFirst(
            amount,
            (await openInvoices(tx, ctx, customer.id)).map((i) => ({
              id: i.id,
              open: i.open,
              dueDate: i.dueOn,
              number: i.number,
            })),
          ).allocations
        : [];
      for (const a of applied)
        await tx.customerReceiptAllocation.create({
          data: {
            organizationId: ctx.organizationId,
            receiptId: r.id,
            invoiceId: a.invoiceId,
            amount: a.amount.toFixed(),
            createdByUserId: ctx.userId,
          },
        });
      await recordAudit(tx, actorOf(ctx), {
        action: "customer_receipt.recorded",
        entityType: "customer_receipt",
        entityId: r.id,
        changes: {
          number: r.number,
          amount: amount.toFixed(),
          allocations: applied.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount.toFixed() })),
        },
      });
      return r;
    },
  );
}

export async function voidCustomerReceipt(
  ctx: TenantContext,
  receiptId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "b2b.manage");
  const parsed = z.object({ reason: requiredText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const r = await tx.customerReceipt.findFirst({
      where: { organizationId: ctx.organizationId, id: receiptId },
    });
    if (!r) throw notFound("Receipt");
    await lockCustomer(tx, ctx, r.customerId);
    if (r.status !== "POSTED") throw businessRuleViolation("SETTLEMENT_VOIDED", "Already voided");
    await tx.customerReceipt.update({
      where: { id: r.id },
      data: {
        status: "VOIDED",
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        voidReason: parsed.data.reason,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "customer_receipt.voided",
      entityType: "customer_receipt",
      entityId: r.id,
      changes: { number: r.number, reason: parsed.data.reason },
    });
  });
}

export type AgingTotals = Record<AgingBucket, Decimal>;
const emptyAging = (): AgingTotals =>
  Object.fromEntries(AGING_BUCKETS.map((b) => [b, zero()])) as AgingTotals;

/** What each customer owes on `asOf`, open invoices aged by due date, unapplied receipts. */
export async function customerBalances(ctx: TenantContext, asOf?: string) {
  assertPermission(ctx.grants, "b2b.view");
  const on = asOf && isCalendarDate(asOf) ? asOf : businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const invoices = await tx.salesInvoice.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: "POSTED",
        invoiceDate: { lte: new Date(`${on}T00:00:00Z`) },
      },
      select: { id: true, customerId: true, invoiceDate: true, dueDate: true, grossAmount: true },
    });
    const receipts = await tx.customerReceipt.groupBy({
      by: ["customerId"],
      where: {
        organizationId: ctx.organizationId,
        status: "POSTED",
        date: { lte: new Date(`${on}T00:00:00Z`) },
      },
      _sum: { amount: true },
    });
    const got = await received(
      tx,
      ctx,
      invoices.map((i) => i.id),
      on,
    );
    const ids = [
      ...new Set([...invoices.map((i) => i.customerId), ...receipts.map((r) => r.customerId)]),
    ];
    const customers = await tx.customer.findMany({
      where: { organizationId: ctx.organizationId, id: { in: ids } },
      select: { id: true, code: true, name: true, nameAr: true },
    });
    const rows = customers.map((c) => {
      const aging = emptyAging();
      let invoiced = zero();
      let openTotal = zero();
      for (const i of invoices.filter((x) => x.customerId === c.id)) {
        invoiced = invoiced.plus(dec(i.grossAmount));
        const open = Decimal.max(dec(i.grossAmount).minus(got.get(i.id) ?? 0), 0);
        if (!open.gt(0)) continue;
        openTotal = openTotal.plus(open);
        const b = agingBucket(day(i.dueDate ?? i.invoiceDate), on);
        aging[b] = aging[b].plus(open);
      }
      const paid = dec(receipts.find((r) => r.customerId === c.id)?._sum.amount ?? 0);
      const balance = invoiced.minus(paid);
      return {
        customer: c,
        invoiced,
        received: paid,
        balance,
        unapplied: Decimal.max(openTotal.minus(balance), 0),
        aging,
      };
    });
    return {
      asOf: on,
      rows: rows.sort(
        (a, b) => b.balance.comparedTo(a.balance) || a.customer.code.localeCompare(b.customer.code),
      ),
    };
  });
}

export async function customerAccount(ctx: TenantContext, customerId: string) {
  assertPermission(ctx.grants, "b2b.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { organizationId: ctx.organizationId, id: customerId },
    });
    if (!customer) throw notFound("Customer");
    const open = (await openInvoices(tx, ctx, customerId)).filter((i) => i.open.gt(0));
    const receipts = await tx.customerReceipt.findMany({
      where: { organizationId: ctx.organizationId, customerId },
      include: { allocations: { select: { amount: true } } },
      orderBy: { date: "desc" },
      take: 50,
    });
    return {
      customer,
      open,
      receipts: receipts.map((r) => ({
        ...r,
        unapplied:
          r.status === "POSTED"
            ? dec(r.amount).minus(r.allocations.reduce((a, x) => a.plus(dec(x.amount)), zero()))
            : zero(),
      })),
    };
  });
}
