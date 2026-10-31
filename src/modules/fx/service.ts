import "server-only";
import { z } from "zod";
import { parseCsvRecords } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { currencyDecimals } from "@/modules/tax/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, validationFailed } from "@/server/errors";
import {
  DOCUMENT_CURRENCIES,
  MAX_RATE_AGE_DAYS,
  isDocumentCurrency,
  pickRate,
  toBase,
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
  if (!isDocumentCurrency(currency, ctx.baseCurrency))
    throw businessRuleViolation("CURRENCY_NOT_SUPPORTED", "This currency is not available", {
      field,
      currency,
    });
}

/**
 * The rate for a document in `currency` dated `date` (1 for the base
 * currency). Throws NO_EXCHANGE_RATE / EXCHANGE_RATE_STALE so nothing is
 * ever converted at a guessed rate.
 */
export async function rateFor(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  date: string,
  field = "currency",
): Promise<FxRate> {
  if (currency === ctx.baseCurrency) return { rate: new Decimal(1), rateDate: date };
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
  const pick = pickRate(
    currency,
    ctx.baseCurrency,
    rows.map((r) => ({ rateDate: day(r.rateDate), rate: new Decimal(r.rate.toString()) })),
    date,
  );
  if (!pick.ok)
    throw businessRuleViolation(
      pick.reason === "NO_RATE" ? "NO_EXCHANGE_RATE" : "EXCHANGE_RATE_STALE",
      "No usable exchange rate for this date",
      { field, currency, date, latest: pick.latest ?? "", days: MAX_RATE_AGE_DAYS },
    );
  return { rate: pick.rate, rateDate: pick.rateDate };
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
  if (input.currency === ctx.baseCurrency)
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
      else if (parsed.data.currency === ctx.baseCurrency)
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
    const latest = DOCUMENT_CURRENCIES.filter((c) => c !== ctx.baseCurrency).map((c) => ({
      currency: c,
      rate: history.find((h) => h.currency === c) ?? null,
    }));
    return { latest, history };
  });
}
