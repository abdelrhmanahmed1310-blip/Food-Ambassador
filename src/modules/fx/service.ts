import "server-only";
import { z } from "zod";
import { parseCsvRecords } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { currencyDecimals } from "@/modules/tax/rules";
import { inCurrency, type TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, validationFailed } from "@/server/errors";
import {
  DOCUMENT_CURRENCIES,
  MAX_RATE_AGE_DAYS,
  isDocumentCurrency,
  pickRate,
  toBase,
  type RatePick,
} from "./rules";

/**
 * Exchange rates (DECISIONS.md ADR-050). Entered by hand or imported from a
 * CSV; no live feed is connected or claimed. A document copies the rate it
 * used, so a later correction never changes posted documents.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);

export interface FxRate {
  rate: Decimal;
  rateDate: string;
}

/** Refuse currencies outside the allowed list. */
export function assertDocumentCurrency(ctx: TenantContext, currency: string, field = "currency") {
  if (!isDocumentCurrency(currency, ctx.baseCurrency) && currency !== ctx.groupCurrency)
    throw businessRuleViolation("CURRENCY_NOT_SUPPORTED", "This currency is not available", {
      field,
      currency,
    });
}

/** Group-currency units for one unit of `currency` on `date` (stored rates are against the group's currency). */
async function groupRate(tx: Tx, ctx: TenantContext, currency: string, date: string) {
  if (currency === ctx.groupCurrency)
    return { ok: true as const, rate: new Decimal(1), rateDate: date };
  const rows = await tx.exchangeRate.findMany({
    where: {
      organizationId: ctx.organizationId,
      currency,
      rateDate: { lte: new Date(`${date}T00:00:00Z`) },
    },
    orderBy: { rateDate: "desc" },
    take: 1,
    select: { rateDate: true, rate: true },
  });
  return pickRate(
    currency,
    ctx.groupCurrency,
    rows.map((r) => ({ rateDate: day(r.rateDate), rate: new Decimal(r.rate.toString()) })),
    date,
  );
}

/**
 * The rate for a document in `currency` dated `date`, in units of the
 * context's currency (1 for the same currency). A company keeping its books
 * in another currency than the group's uses the cross rate through the group
 * currency (ADR-086). Throws NO_EXCHANGE_RATE / EXCHANGE_RATE_STALE so
 * nothing is ever converted at a guessed rate.
 */
export async function rateFor(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  date: string,
  field = "currency",
): Promise<FxRate> {
  if (currency === ctx.baseCurrency) return { rate: new Decimal(1), rateDate: date };
  const legs = [
    { currency, pick: await groupRate(tx, ctx, currency, date) },
    { currency: ctx.baseCurrency, pick: await groupRate(tx, ctx, ctx.baseCurrency, date) },
  ];
  for (const { currency: c, pick } of legs)
    if (!pick.ok)
      throw businessRuleViolation(
        pick.reason === "NO_RATE" ? "NO_EXCHANGE_RATE" : "EXCHANGE_RATE_STALE",
        "No usable exchange rate for this date",
        { field, currency: c, date, latest: pick.latest ?? "", days: MAX_RATE_AGE_DAYS },
      );
  const [doc, books] = legs.map((l) => l.pick as Extract<RatePick, { ok: true }>);
  return {
    rate: doc.rate.dividedBy(books.rate).toDecimalPlaces(10, Decimal.ROUND_HALF_UP),
    rateDate: doc.rateDate < books.rateDate ? doc.rateDate : books.rateDate,
  };
}

/**
 * Converts amounts kept in company currencies into one reporting currency —
 * the group's for consolidated figures, or one company's (ADR-086): at the
 * rate on `date` (period end, for balances), or the average of the period's
 * rates when `from` is given (for flows such as sales, costs and waste).
 * Rates are stored against the group currency, so other pairs go through it.
 * A currency without a usable rate is not converted: it is reported in
 * `missing()` and its amounts are left out rather than guessed.
 */
export async function currencyConverter(
  tx: Tx,
  ctx: TenantContext,
  at: { to?: string; date: string; from?: string },
) {
  const to = at.to ?? ctx.groupCurrency;
  const cache = new Map<string, Decimal | null>();
  const missing = new Set<string>();
  async function groupUnits(currency: string) {
    if (currency === ctx.groupCurrency) return new Decimal(1);
    if (cache.has(currency)) return cache.get(currency)!;
    let rate: Decimal | null = null;
    if (at.from) {
      const inPeriod = await tx.exchangeRate.findMany({
        where: {
          organizationId: ctx.organizationId,
          currency,
          rateDate: {
            gte: new Date(`${at.from}T00:00:00Z`),
            lte: new Date(`${at.date}T00:00:00Z`),
          },
        },
        select: { rate: true },
      });
      if (inPeriod.length > 0)
        rate = inPeriod
          .reduce((acc, r) => acc.plus(r.rate.toString()), new Decimal(0))
          .dividedBy(inPeriod.length);
    }
    if (!rate) {
      const pick = await groupRate(tx, ctx, currency, at.date);
      rate = pick.ok ? pick.rate : null;
    }
    cache.set(currency, rate);
    if (!rate) missing.add(currency);
    return rate;
  }
  const decimals = currencyDecimals(to);
  return {
    currency: to,
    /** The amount in the reporting currency, or null when a currency has no usable rate. */
    async convert(amount: Decimal, currency: string) {
      if (currency === to) return amount;
      const [from, target] = [await groupUnits(currency), await groupUnits(to)];
      if (!from || !target) return null;
      return amount.times(from).dividedBy(target).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
    },
    /** Currencies left out for want of a rate. */
    missing: () => [...missing].sort(),
  };
}

/**
 * Stock moves only between warehouses whose companies share a currency: an
 * inter-company transfer (a sale and a purchase) does not exist yet (ADR-086).
 */
export async function assertSameCurrency(tx: Tx, ctx: TenantContext, fromId: string, toId: string) {
  if (fromId === toId) return;
  const currencies = await warehouseCurrencies(tx, ctx, [fromId, toId]);
  if (currencies.get(fromId) !== currencies.get(toId))
    throw businessRuleViolation(
      "TRANSFER_OTHER_CURRENCY",
      "Stock cannot move between companies with different currencies",
      { field: "toWarehouseId" },
    );
}

/**
 * Money flows not yet kept in a company's own currency (ADR-086 steps 3b/3c)
 * refuse a company whose currency is not the group's (the database refuses
 * too). Each step removes its calls as its flow is converted.
 */
export async function assertFlowInGroupCurrency(
  tx: Tx,
  ctx: TenantContext,
  at: { warehouseId?: string; companyId?: string | null },
) {
  const currency = at.warehouseId
    ? (await warehouseCurrencies(tx, ctx, [at.warehouseId])).get(at.warehouseId)
    : (
        await tx.company.findFirst({
          where: {
            organizationId: ctx.organizationId,
            ...(at.companyId ? { id: at.companyId } : { isDefault: true }),
          },
          select: { currency: true },
        })
      )?.currency;
  if (currency && currency !== ctx.groupCurrency)
    throw businessRuleViolation(
      "COMPANY_CURRENCY_NOT_YET_SUPPORTED",
      "This is not yet available for a company keeping its books in another currency",
      { currency },
    );
}

/**
 * The context for one company's documents (ADR-086): its id, currency and the
 * same user working in that currency. The company comes from `at` (company,
 * or a warehouse's branch's); without either, the default company.
 */
export async function companyContext(
  tx: Tx,
  ctx: TenantContext,
  at: { companyId?: string | null; warehouseId?: string | null; branchId?: string | null },
) {
  const c = await tx.company.findFirst({
    where: {
      organizationId: ctx.organizationId,
      ...(at.companyId
        ? { id: at.companyId }
        : at.branchId
          ? { branches: { some: { id: at.branchId } } }
          : at.warehouseId
            ? { branches: { some: { warehouses: { some: { id: at.warehouseId } } } } }
            : { isDefault: true }),
    },
    select: { id: true, currency: true },
  });
  if (!c)
    throw businessRuleViolation("BRANCH_COMPANY_INVALID", "Choose an active company", {
      field: "companyId",
    });
  return { companyId: c.id, currency: c.currency, ctx: inCurrency(ctx, c.currency) };
}

/** The currency of each warehouse: its branch's company's (ADR-086). */
export async function warehouseCurrencies(tx: Tx, ctx: TenantContext, ids?: string[]) {
  const rows = await tx.warehouse.findMany({
    where: { organizationId: ctx.organizationId, ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true, branch: { select: { company: { select: { currency: true } } } } },
  });
  return new Map(rows.map((w) => [w.id, w.branch.company.currency]));
}

/** Base-currency amount at a rate, rounded to the base unit. */
export const baseAmount = (ctx: TenantContext, amount: Decimal, rate: Decimal) =>
  toBase(amount, rate, currencyDecimals(ctx.baseCurrency));

const rateSchema = z.object({
  currency: z.enum(DOCUMENT_CURRENCIES, { error: "invalidOption" }),
  rateDate: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  rate: decimalString({ maxScale: 10, min: "0.0000000001" }),
});

async function upsertRate(
  tx: Tx,
  ctx: TenantContext,
  input: z.infer<typeof rateSchema>,
  source: "MANUAL" | "CSV",
) {
  if (input.currency === ctx.groupCurrency)
    throw businessRuleViolation("BASE_CURRENCY_RATE", "The base currency needs no rate", {
      field: "currency",
    });
  const key = {
    organizationId: ctx.organizationId,
    currency: input.currency,
    rateDate: new Date(`${input.rateDate}T00:00:00Z`),
  };
  const before = await tx.exchangeRate.findUnique({
    where: { organizationId_currency_rateDate: key },
    select: { rate: true },
  });
  await tx.exchangeRate.upsert({
    where: { organizationId_currency_rateDate: key },
    create: { ...key, rate: input.rate, source, createdByUserId: ctx.userId },
    update: { rate: input.rate, source },
  });
  return before ? before.rate.toFixed() : null;
}

export async function setExchangeRate(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "fx.manage");
  const parsed = rateSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const before = await upsertRate(tx, ctx, parsed.data, "MANUAL");
    await recordAudit(tx, actorOf(ctx), {
      action: before === null ? "exchange_rate.created" : "exchange_rate.corrected",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: { ...parsed.data, from: before },
    });
  });
}

/** CSV with columns date, currency, rate. All rows are checked first; nothing is saved if any is wrong. */
export async function importExchangeRates(ctx: TenantContext, text: string) {
  assertPermission(ctx.grants, "fx.manage");
  const { headers: header, records: rows } = parseCsvRecords(text);
  const errors: Array<{ row: number; message: string }> = [];
  for (const col of ["date", "currency", "rate"])
    if (!header.includes(col)) errors.push({ row: 1, message: `missingColumn:${col}` });
  const valid: Array<z.infer<typeof rateSchema>> = [];
  if (errors.length === 0)
    rows.forEach((r, i) => {
      const parsed = rateSchema.safeParse({
        currency: (r.currency ?? "").trim().toUpperCase(),
        rateDate: (r.date ?? "").trim(),
        rate: (r.rate ?? "").trim(),
      });
      if (!parsed.success) errors.push({ row: i + 2, message: "invalidRow" });
      else if (parsed.data.currency === ctx.groupCurrency)
        errors.push({ row: i + 2, message: "baseCurrency" });
      else valid.push(parsed.data);
    });
  if (errors.length > 0 || valid.length === 0)
    return { ok: false as const, errors: errors.length ? errors : [{ row: 1, message: "empty" }] };
  await withTenantTx(ctx.organizationId, async (tx) => {
    for (const r of valid) await upsertRate(tx, ctx, r, "CSV");
    await recordAudit(tx, actorOf(ctx), {
      action: "exchange_rate.imported",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: { rows: valid.length },
    });
  });
  return { ok: true as const, imported: valid.length };
}

/** Latest rate per currency and the recent history, for the rates page. */
export async function listExchangeRates(ctx: TenantContext) {
  assertPermission(ctx.grants, "fx.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const history = await tx.exchangeRate.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ rateDate: "desc" }, { currency: "asc" }],
      take: 200,
      select: {
        id: true,
        currency: true,
        rateDate: true,
        rate: true,
        source: true,
        updatedAt: true,
      },
    });
    const latest = DOCUMENT_CURRENCIES.filter((c) => c !== ctx.groupCurrency).map((c) => ({
      currency: c,
      rate: history.find((h) => h.currency === c) ?? null,
    }));
    return { latest, history };
  });
}
