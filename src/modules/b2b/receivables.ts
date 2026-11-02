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
  optionalUuidSchema,
  uuidSchema,
} from "@/modules/shared/schemas";
import { realisedDifference, toBase } from "@/modules/fx/rules";
import {
  assertDocumentCurrency,
  baseAmount,
  companyContext,
  currencyConverter,
  rateFor,
} from "@/modules/fx/service";
import { optionalCurrency } from "@/modules/procurement/schemas";
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
  /** The receiving company (ADR-086); empty = the default company. */
  companyId: optionalUuidSchema,
  date: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  amount: decimalString({ maxScale: 4, min: "0.0001" }),
  method: z.enum(PAYMENT_METHODS, { error: "invalidOption" }),
  reference: optionalText(80),
  note: optionalText(500),
  autoAllocate: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  /** Empty = the customer's currency (ADR-054). */
  currency: optionalCurrency,
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

async function openInvoices(
  tx: Tx,
  ctx: TenantContext,
  customerId: string,
  currency?: string,
  companyId?: string,
) {
  const invoices = await tx.salesInvoice.findMany({
    where: {
      organizationId: ctx.organizationId,
      customerId,
      status: "POSTED",
      ...(currency ? { currency } : {}),
      ...(companyId ? { companyId } : {}),
    },
    select: {
      id: true,
      companyId: true,
      number: true,
      invoiceDate: true,
      dueDate: true,
      grossAmount: true,
      currency: true,
      exchangeRate: true,
    },
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
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "customer_receipt", input },
    async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { organizationId: ctx.organizationId, id: input.customerId },
        select: { id: true, currency: true },
      });
      if (!customer) throw notFound("Customer");
      if (
        input.companyId &&
        !(await tx.company.findFirst({
          where: { organizationId: ctx.organizationId, id: input.companyId, archivedAt: null },
          select: { id: true },
        }))
      )
        throw businessRuleViolation("BRANCH_COMPANY_INVALID", "Choose an active company", {
          field: "companyId",
        });
      // Base amounts in the receiving company's currency (ADR-086).
      const company = await companyContext(tx, ctx, { companyId: input.companyId });
      const currency = input.currency ?? customer.currency ?? company.currency;
      assertDocumentCurrency(company.ctx, currency);
      if (amount.decimalPlaces() > currencyDecimals(currency))
        throw businessRuleViolation("AMOUNT_TOO_PRECISE", "More decimals than the currency has", {
          field: "amount",
          decimals: currencyDecimals(currency),
        });
      await lockCustomer(tx, ctx, customer.id);
      const fx = await rateFor(tx, company.ctx, currency, input.date);
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
          companyId: company.companyId,
          date: new Date(`${input.date}T00:00:00Z`),
          amount: amount.toFixed(),
          currency,
          exchangeRate: fx.rate.toFixed(),
          rateDate: new Date(`${fx.rateDate}T00:00:00Z`),
          amountBase: baseAmount(company.ctx, amount, fx.rate).toFixed(),
          method: input.method,
          reference: input.reference,
          note: input.note,
          createdByUserId: ctx.userId,
        },
        select: { id: true, number: true },
      });
      // Only invoices in the receipt's currency and of its company (ADR-054/086).
      const open = await openInvoices(tx, ctx, customer.id, currency, company.companyId);
      const applied = input.autoAllocate
        ? allocateOldestFirst(
            amount,
            open.map((i) => ({
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
            // Realised difference: booked at the invoice rate, received at this one (+ = gain).
            fxDifferenceBase: realisedDifference(
              a.amount,
              dec(open.find((i) => i.id === a.invoiceId)!.exchangeRate),
              fx.rate,
              currencyDecimals(company.currency),
            ).toFixed(),
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
          currency,
          rate: fx.rate.toFixed(),
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

/**
 * What each customer owes on `asOf`, per selling company and currency
 * (ADR-054/086): open invoices aged by due date, unapplied receipts, and a
 * base equivalent in the company's currency at the documents' own rates;
 * the total in the group currency, each row converted at the rate on
 * `asOf` (a currency without a usable rate is left out and named).
 */
export async function customerBalances(ctx: TenantContext, asOf?: string) {
  assertPermission(ctx.grants, "b2b.view");
  const on = asOf && isCalendarDate(asOf) ? asOf : businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const until = new Date(`${on}T00:00:00Z`);
    const invoices = await tx.salesInvoice.findMany({
      where: { organizationId: ctx.organizationId, status: "POSTED", invoiceDate: { lte: until } },
      select: {
        id: true,
        customerId: true,
        companyId: true,
        currency: true,
        exchangeRate: true,
        invoiceDate: true,
        dueDate: true,
        grossAmount: true,
      },
    });
    const receipts = await tx.customerReceipt.findMany({
      where: { organizationId: ctx.organizationId, status: "POSTED", date: { lte: until } },
      select: {
        id: true,
        customerId: true,
        companyId: true,
        currency: true,
        exchangeRate: true,
        amount: true,
        allocations: { select: { amount: true, invoice: { select: { invoiceDate: true } } } },
      },
    });
    const got = await received(
      tx,
      ctx,
      invoices.map((i) => i.id),
      on,
    );
    const keyOf = (d: { customerId: string; companyId: string | null; currency: string }) =>
      `${d.customerId}|${d.companyId}|${d.currency}`;
    const keys = [...new Set([...invoices, ...receipts].map(keyOf))];
    const companies = await tx.company.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, code: true, name: true, currency: true },
    });
    const customers = await tx.customer.findMany({
      where: {
        organizationId: ctx.organizationId,
        id: { in: [...new Set(keys.map((k) => k.split("|")[0]))] },
      },
      select: { id: true, code: true, name: true, nameAr: true },
    });
    const rows = keys.map((key) => {
      const [customerId, companyId, currency] = key.split("|");
      const c = customers.find((x) => x.id === customerId)!;
      const company = companies.find((x) => x.id === companyId)!;
      const baseDecimals = currencyDecimals(company.currency);
      const aging = emptyAging();
      let invoiced = zero();
      let openTotal = zero();
      let balanceBase = zero();
      for (const i of invoices.filter((x) => keyOf(x) === key)) {
        invoiced = invoiced.plus(dec(i.grossAmount));
        const open = Decimal.max(dec(i.grossAmount).minus(got.get(i.id) ?? 0), 0);
        if (!open.gt(0)) continue;
        openTotal = openTotal.plus(open);
        const b = agingBucket(day(i.dueDate ?? i.invoiceDate), on);
        aging[b] = aging[b].plus(open);
        balanceBase = balanceBase.plus(toBase(open, dec(i.exchangeRate), baseDecimals));
      }
      let paid = zero();
      for (const r of receipts.filter((x) => keyOf(x) === key)) {
        paid = paid.plus(dec(r.amount));
        const used = r.allocations
          .filter((a) => a.invoice.invoiceDate <= until)
          .reduce((a, x) => a.plus(dec(x.amount)), zero());
        const left = dec(r.amount).minus(used);
        if (left.gt(0))
          balanceBase = balanceBase.minus(toBase(left, dec(r.exchangeRate), baseDecimals));
      }
      const balance = invoiced.minus(paid);
      return {
        customer: c,
        company: { id: company.id, code: company.code, name: company.name },
        /** The base amounts' currency: the selling company's (ADR-086). */
        baseCurrency: company.currency,
        currency,
        invoiced,
        received: paid,
        balance,
        unapplied: Decimal.max(openTotal.minus(balance), 0),
        aging,
        balanceBase,
      };
    });
    const conv = await currencyConverter(tx, ctx, { date: on });
    let totalBase = zero();
    for (const r of rows) {
      const v = await conv.convert(r.balanceBase, r.baseCurrency);
      if (v) totalBase = totalBase.plus(v);
    }
    return {
      asOf: on,
      /** The total's currency (the group's) and currencies left out for want of a rate. */
      currency: conv.currency,
      missingRates: conv.missing(),
      totalBase,
      rows: rows.sort(
        (a, b) =>
          a.company.code.localeCompare(b.company.code) ||
          b.balanceBase.comparedTo(a.balanceBase) ||
          a.customer.code.localeCompare(b.customer.code) ||
          a.currency.localeCompare(b.currency),
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
      include: {
        allocations: { select: { amount: true } },
        company: { select: { code: true, currency: true } },
      },
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
