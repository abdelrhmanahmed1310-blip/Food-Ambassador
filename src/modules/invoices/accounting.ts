import "server-only";
import { z } from "zod";
import { toCsv } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { Decimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { currencyDecimals } from "@/modules/tax/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, validationFailed } from "@/server/errors";
import { journalLines, type Accounts } from "./payables-rules";

/**
 * Accounting export of payables (DECISIONS.md ADR-039): a documents file
 * (one row per document and VAT rate) and a balanced journal using the
 * organization's own account codes. Nothing is posted to an ERP from here.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);

const account = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null))
  .refine((v) => v === null || /^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,39}$/u.test(v), {
    error: "invalidAccountCode",
  });

const accountsSchema = z.object({
  payablesAccount: account,
  purchasesAccount: account,
  inputVatAccount: account,
  paymentsAccount: account,
  /** Realised exchange gains and losses (ADR-050). */
  fxDifferenceAccount: account,
});

const periodSchema = z
  .object({
    from: z.string().refine(isCalendarDate, { error: "invalidDate" }),
    to: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  })
  .refine((p) => p.from <= p.to, { error: "invalidPeriod", path: ["to"] });

export async function getAccountingSettings(ctx: TenantContext) {
  assertPermission(ctx.grants, "org.settings.manage");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.accountingSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
  );
}

export async function updateAccountingSettings(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = accountsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.accountingSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ...parsed.data },
      update: parsed.data,
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "accounting.settings_updated",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: parsed.data,
    });
  });
}

/** Posted invoices (per VAT rate), credit notes and payments dated in the period. */
async function documentsIn(ctx: TenantContext, period: { from: string; to: string }) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const range = {
      gte: new Date(`${period.from}T00:00:00Z`),
      lte: new Date(`${period.to}T00:00:00Z`),
    };
    const invoices = await tx.supplierInvoice.findMany({
      where: { organizationId: ctx.organizationId, status: "POSTED", invoiceDate: range },
      include: {
        supplier: { select: { code: true, name: true, taxId: true } },
        lines: { include: { taxCode: { select: { code: true } } } },
      },
      orderBy: [{ invoiceDate: "asc" }, { number: "asc" }],
    });
    const settlements = await tx.supplierSettlement.findMany({
      where: { organizationId: ctx.organizationId, status: "POSTED", date: range },
      include: {
        supplier: { select: { code: true, name: true, taxId: true } },
        taxCode: { select: { code: true } },
        allocations: { select: { fxDifferenceBase: true } },
      },
      orderBy: [{ date: "asc" }, { number: "asc" }],
    });
    const settings = await tx.taxSettings.findUnique({
      where: { organizationId: ctx.organizationId },
    });
    const accounts = await tx.accountingSettings.findUnique({
      where: { organizationId: ctx.organizationId },
    });
    // Revaluations dated in the period, and those whose reversal (next day) falls in it (ADR-052).
    const dayBefore = new Date(range.gte.getTime() - 86_400_000);
    const revaluations = await tx.fxRevaluation.findMany({
      where: {
        organizationId: ctx.organizationId,
        cancelledAt: null,
        asOf: { gte: dayBefore, lte: range.lte },
      },
      include: { lines: { include: { supplier: { select: { code: true } } } } },
    });
    return {
      invoices,
      settlements,
      revaluations,
      vatRegistered: settings?.vatRegistered ?? false,
      accounts,
    };
  });
}

export async function exportPayablesDocumentsCsv(ctx: TenantContext, rawPeriod: unknown) {
  assertPermission(ctx.grants, "invoices.view");
  const parsed = periodSchema.safeParse(rawPeriod);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { invoices, settlements } = await documentsIn(ctx, parsed.data);
  const basePlaces = currencyDecimals(ctx.baseCurrency);
  const baseMoney = (v: Decimal) => v.toFixed(basePlaces);
  const rate = (v: { toString(): string }) => dec(v).toFixed();
  const rows: Array<Array<string | null>> = [];
  for (const inv of invoices) {
    const byRate = new Map<
      string,
      { code: string | null; rate: string | null; net: Decimal; tax: Decimal; gross: Decimal }
    >();
    for (const l of inv.lines) {
      const rate = l.taxRate === null ? null : dec(l.taxRate).toFixed();
      const key = `${l.taxCode?.code ?? ""}|${rate ?? ""}`;
      const e = byRate.get(key) ?? {
        code: l.taxCode?.code ?? null,
        rate,
        net: new Decimal(0),
        tax: new Decimal(0),
        gross: new Decimal(0),
      };
      e.net = e.net.plus(dec(l.netAmount));
      e.tax = e.tax.plus(dec(l.taxAmount));
      e.gross = e.gross.plus(dec(l.grossAmount));
      byRate.set(key, e);
    }
    const places = currencyDecimals(inv.currency);
    const money = (v: Decimal) => v.toFixed(places);
    const fx = dec(inv.exchangeRate);
    const toBase = (v: Decimal) =>
      baseMoney(v.times(fx).toDecimalPlaces(basePlaces, Decimal.ROUND_HALF_UP));
    for (const e of byRate.values())
      rows.push([
        "INVOICE",
        inv.number,
        day(inv.invoiceDate),
        inv.dueDate ? day(inv.dueDate) : null,
        inv.supplier.code,
        inv.supplier.name,
        inv.supplier.taxId,
        inv.supplierInvoiceNo,
        e.code,
        e.rate,
        money(e.net),
        money(e.tax),
        money(e.gross),
        inv.currency,
        null,
        rate(inv.exchangeRate),
        toBase(e.net),
        toBase(e.tax),
        baseMoney(dec(toBase(e.net)).plus(dec(toBase(e.tax)))),
      ]);
  }
  for (const s of settlements) {
    const money = (v: Decimal) => v.toFixed(currencyDecimals(s.currency));
    const fx = dec(s.exchangeRate);
    const netBase = dec(s.amountBase).minus(dec(s.taxAmountBase));
    rows.push([
      s.kind,
      s.number,
      day(s.date),
      null,
      s.supplier.code,
      s.supplier.name,
      s.supplier.taxId,
      s.supplierDocumentNo ?? s.reference,
      s.taxCode?.code ?? null,
      s.taxRate === null ? null : dec(s.taxRate).toFixed(),
      s.netAmount === null ? null : money(dec(s.netAmount)),
      money(dec(s.taxAmount)),
      money(dec(s.amount)),
      s.currency,
      s.method,
      fx.toFixed(),
      s.netAmount === null ? null : baseMoney(netBase),
      baseMoney(dec(s.taxAmountBase)),
      baseMoney(dec(s.amountBase)),
    ]);
  }
  return toCsv(
    [
      "document_type",
      "number",
      "date",
      "due_date",
      "supplier_code",
      "supplier_name",
      "supplier_vat_number",
      "supplier_reference",
      "vat_code",
      "vat_rate",
      "net",
      "vat",
      "gross",
      "currency",
      "payment_method",
      "exchange_rate",
      "net_base",
      "vat_base",
      "gross_base",
    ],
    rows,
  );
}

export async function exportPayablesJournalCsv(ctx: TenantContext, rawPeriod: unknown) {
  assertPermission(ctx.grants, "invoices.view");
  const parsed = periodSchema.safeParse(rawPeriod);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { invoices, settlements, revaluations, vatRegistered, accounts } = await documentsIn(
    ctx,
    parsed.data,
  );
  if (
    !accounts?.payablesAccount ||
    !accounts.purchasesAccount ||
    !accounts.paymentsAccount ||
    (vatRegistered && !accounts.inputVatAccount)
  )
    throw businessRuleViolation(
      "ACCOUNTS_NOT_SET",
      "Set the account codes in purchasing settings before exporting a journal",
    );
  const fxOf = (s: (typeof settlements)[number]) =>
    s.allocations.reduce((a, x) => a.plus(dec(x.fxDifferenceBase)), new Decimal(0));
  if (
    !accounts.fxDifferenceAccount &&
    (settlements.some((s) => !fxOf(s).isZero()) || revaluations.length > 0)
  )
    throw businessRuleViolation(
      "ACCOUNTS_NOT_SET",
      "Set the exchange difference account before exporting a journal with foreign-currency settlements",
    );
  const codes: Accounts = {
    payables: accounts.payablesAccount,
    purchases: accounts.purchasesAccount,
    inputVat: accounts.inputVatAccount ?? "",
    payments: accounts.paymentsAccount,
  };
  const places = currencyDecimals(ctx.baseCurrency);
  const money = (v: Decimal) => (v.isZero() ? null : v.toFixed(places));
  const docs = [
    ...invoices.map((i) => ({
      date: day(i.invoiceDate),
      type: "INVOICE" as const,
      number: i.number,
      supplier: i.supplier.code,
      reference: i.supplierInvoiceNo,
      // The journal is in base currency (ADR-050).
      lines: journalLines(
        {
          kind: "INVOICE",
          net: dec(i.netAmountBase),
          tax: dec(i.taxAmountBase),
          gross: dec(i.grossAmountBase),
        },
        codes,
        vatRegistered,
      ),
    })),
    ...settlements.map((s) => ({
      date: day(s.date),
      type: s.kind,
      number: s.number,
      supplier: s.supplier.code,
      reference: s.supplierDocumentNo ?? s.reference,
      lines: [
        ...(s.kind === "PAYMENT"
          ? journalLines({ kind: "PAYMENT", gross: dec(s.amountBase) }, codes, vatRegistered)
          : journalLines(
              {
                kind: "CREDIT_NOTE",
                net: dec(s.amountBase).minus(dec(s.taxAmountBase)),
                tax: dec(s.taxAmountBase),
                gross: dec(s.amountBase),
              },
              codes,
              vatRegistered,
            )),
        ...fxLines(fxOf(s), accounts.payablesAccount!, accounts.fxDifferenceAccount ?? ""),
      ],
    })),
    // Unrealised differences on the revaluation date, reversed the next day.
    ...revaluations.flatMap((r) => {
      const on = day(r.asOf);
      const next = day(new Date(r.asOf.getTime() + 86_400_000));
      const lines = (sign: 1 | -1) =>
        r.lines.flatMap((l) =>
          fxLines(
            dec(l.differenceBase).times(sign),
            accounts.payablesAccount!,
            accounts.fxDifferenceAccount ?? "",
          ),
        );
      return [
        ...(on >= parsed.data.from && on <= parsed.data.to
          ? [
              {
                date: on,
                type: "FX_REVALUATION" as const,
                number: r.number,
                supplier: "",
                reference: "",
                lines: lines(1),
              },
            ]
          : []),
        ...(next >= parsed.data.from && next <= parsed.data.to
          ? [
              {
                date: next,
                type: "FX_REVALUATION_REVERSAL" as const,
                number: `${r.number}-R`,
                supplier: "",
                reference: r.number,
                lines: lines(-1),
              },
            ]
          : []),
      ];
    }),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  const rows = docs.flatMap((d) =>
    d.lines.map((l) => [
      d.number,
      d.date,
      d.type,
      d.supplier,
      d.reference,
      l.account,
      money(l.debit),
      money(l.credit),
      ctx.baseCurrency,
    ]),
  );
  return toCsv(
    [
      "entry",
      "date",
      "document_type",
      "supplier_code",
      "reference",
      "account",
      "debit",
      "credit",
      "currency",
    ],
    rows,
  );
}

/**
 * Realised exchange difference of a settlement (ADR-050): a loss (more base
 * currency paid than the invoices were booked at) is debited to the exchange
 * account against payables; a gain the other way round.
 */
function fxLines(diff: Decimal, payables: string, fxAccount: string) {
  const zero = new Decimal(0);
  if (diff.isZero()) return [];
  const amount = diff.abs();
  return diff.gt(0)
    ? [
        { account: fxAccount, debit: amount, credit: zero },
        { account: payables, debit: zero, credit: amount },
      ]
    : [
        { account: payables, debit: amount, credit: zero },
        { account: fxAccount, debit: zero, credit: amount },
      ];
}

/** Whether the journal export has the account codes it needs (for the export page). */
export async function journalReady(ctx: TenantContext) {
  assertPermission(ctx.grants, "invoices.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [a, tax] = await Promise.all([
      tx.accountingSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
      tx.taxSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
    ]);
    return Boolean(
      a?.payablesAccount &&
      a.purchasesAccount &&
      a.paymentsAccount &&
      (!tax?.vatRegistered || a.inputVatAccount),
    );
  });
}
