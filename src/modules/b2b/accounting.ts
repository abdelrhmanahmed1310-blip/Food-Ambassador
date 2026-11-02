import "server-only";
import { companyContext } from "@/modules/fx/service";
import { toCsv } from "@/lib/csv";
import { Decimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { periodSchema } from "@/modules/invoices/accounting";
import { currencyDecimals } from "@/modules/tax/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, validationFailed } from "@/server/errors";

/**
 * Accounting export of B2B receivables (DECISIONS.md ADR-056), like the
 * payables export (ADR-039): a documents file with document currency, rate
 * and base amounts, and a balanced journal in base currency with realised
 * exchange differences and period-end revaluations (reversed the next day).
 * Nothing is posted to an ERP from here.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const zero = new Decimal(0);

type Line = { account: string; debit: Decimal; credit: Decimal };
const dr = (account: string, v: Decimal): Line => ({ account, debit: v, credit: zero });
const cr = (account: string, v: Decimal): Line => ({ account, debit: zero, credit: v });

/** A difference on receivables: + (the amount due grew) is a gain. */
function fxLines(diff: Decimal, receivables: string, fx: string): Line[] {
  if (diff.isZero()) return [];
  return diff.gt(0)
    ? [dr(receivables, diff), cr(fx, diff)]
    : [dr(fx, diff.abs()), cr(receivables, diff.abs())];
}

/** One company's documents, base amounts in its currency (ADR-086). */
async function documentsIn(
  ctx: TenantContext,
  period: { from: string; to: string; companyId?: string },
) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const company = await companyContext(tx, ctx, { companyId: period.companyId });
    const companyId = company.companyId;
    const range = {
      gte: new Date(`${period.from}T00:00:00Z`),
      lte: new Date(`${period.to}T00:00:00Z`),
    };
    const invoices = await tx.salesInvoice.findMany({
      where: {
        organizationId: ctx.organizationId,
        companyId,
        status: "POSTED",
        invoiceDate: range,
      },
      include: { customer: { select: { code: true, name: true, taxId: true } } },
      orderBy: [{ invoiceDate: "asc" }, { number: "asc" }],
    });
    const receipts = await tx.customerReceipt.findMany({
      where: { organizationId: ctx.organizationId, companyId, status: "POSTED", date: range },
      include: {
        customer: { select: { code: true, name: true, taxId: true } },
        allocations: { select: { fxDifferenceBase: true } },
      },
      orderBy: [{ date: "asc" }, { number: "asc" }],
    });
    const revaluations = await tx.fxRevaluation.findMany({
      where: {
        organizationId: ctx.organizationId,
        companyId,
        cancelledAt: null,
        asOf: { gte: new Date(range.gte.getTime() - 86_400_000), lte: range.lte },
      },
      include: { lines: { where: { customerId: { not: null } } } },
    });
    const accounts = await tx.accountingSettings.findUnique({
      where: { organizationId: ctx.organizationId },
    });
    const registered = (
      await tx.company.findFirstOrThrow({
        where: { id: companyId },
        select: { vatRegistered: true },
      })
    ).vatRegistered;
    return {
      invoices,
      receipts,
      revaluations,
      accounts,
      vatRegistered: registered,
      currency: company.currency,
    };
  });
}

export async function exportReceivablesDocumentsCsv(ctx: TenantContext, rawPeriod: unknown) {
  assertPermission(ctx.grants, "b2b.view");
  const parsed = periodSchema.safeParse(rawPeriod);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { invoices, receipts, currency } = await documentsIn(ctx, parsed.data);
  const base = currencyDecimals(currency);
  const rows: Array<Array<string | null>> = [
    ...invoices.map((i) => {
      const places = currencyDecimals(i.currency);
      return [
        "SALES_INVOICE",
        i.number,
        day(i.invoiceDate),
        i.dueDate ? day(i.dueDate) : null,
        i.customer.code,
        i.customer.name,
        i.customer.taxId,
        dec(i.netAmount).toFixed(places),
        dec(i.taxAmount).toFixed(places),
        dec(i.grossAmount).toFixed(places),
        i.currency,
        dec(i.exchangeRate).toFixed(),
        dec(i.netAmountBase).toFixed(base),
        dec(i.taxAmountBase).toFixed(base),
        dec(i.grossAmountBase).toFixed(base),
        dec(i.cost).toFixed(base),
      ];
    }),
    ...receipts.map((r) => [
      "CUSTOMER_RECEIPT",
      r.number,
      day(r.date),
      null,
      r.customer.code,
      r.customer.name,
      r.customer.taxId,
      null,
      null,
      dec(r.amount).toFixed(currencyDecimals(r.currency)),
      r.currency,
      dec(r.exchangeRate).toFixed(),
      null,
      null,
      dec(r.amountBase).toFixed(base),
      null,
    ]),
  ];
  return toCsv(
    [
      "document_type",
      "number",
      "date",
      "due_date",
      "customer_code",
      "customer_name",
      "customer_vat_number",
      "net",
      "vat",
      "gross",
      "currency",
      "exchange_rate",
      "net_base",
      "vat_base",
      "gross_base",
      "cost_of_goods_base",
    ],
    rows,
  );
}

export async function exportReceivablesJournalCsv(ctx: TenantContext, rawPeriod: unknown) {
  assertPermission(ctx.grants, "b2b.view");
  const parsed = periodSchema.safeParse(rawPeriod);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { from, to } = parsed.data;
  const {
    invoices,
    receipts,
    revaluations,
    accounts: a,
    vatRegistered,
    currency,
  } = await documentsIn(ctx, parsed.data);
  const fxOf = (r: (typeof receipts)[number]) =>
    r.allocations.reduce((s, x) => s.plus(dec(x.fxDifferenceBase)), zero);
  const needsFx =
    receipts.some((r) => !fxOf(r).isZero()) || revaluations.some((r) => r.lines.length > 0);
  if (
    !a?.receivablesAccount ||
    !a.salesAccount ||
    !a.receiptsAccount ||
    (vatRegistered && !a.outputVatAccount) ||
    (needsFx && !a.fxDifferenceAccount)
  )
    throw businessRuleViolation(
      "ACCOUNTS_NOT_SET",
      "Set the receivables, sales, receipts, output VAT and exchange accounts first",
    );
  const ar = a.receivablesAccount;
  const fx = a.fxDifferenceAccount ?? "";
  const docs: Array<{ date: string; type: string; number: string; party: string; lines: Line[] }> =
    [
      ...invoices.map((i) => ({
        date: day(i.invoiceDate),
        type: "SALES_INVOICE",
        number: i.number,
        party: i.customer.code,
        lines: [
          dr(ar, dec(i.grossAmountBase)),
          cr(a.salesAccount!, dec(i.netAmountBase)),
          ...(dec(i.taxAmountBase).isZero()
            ? []
            : [cr(a.outputVatAccount ?? "", dec(i.taxAmountBase))]),
        ],
      })),
      ...receipts.map((r) => ({
        date: day(r.date),
        type: "CUSTOMER_RECEIPT",
        number: r.number,
        party: r.customer.code,
        lines: [
          dr(a.receiptsAccount!, dec(r.amountBase)),
          cr(ar, dec(r.amountBase)),
          ...fxLines(fxOf(r), ar, fx),
        ],
      })),
      ...revaluations
        .filter((r) => r.lines.length > 0)
        .flatMap((r) => {
          const on = day(r.asOf);
          const next = day(new Date(r.asOf.getTime() + 86_400_000));
          const lines = (sign: 1 | -1) =>
            r.lines.flatMap((l) => fxLines(dec(l.differenceBase).times(sign), ar, fx));
          return [
            ...(on >= from && on <= to
              ? [{ date: on, type: "FX_REVALUATION", number: r.number, party: "", lines: lines(1) }]
              : []),
            ...(next >= from && next <= to
              ? [
                  {
                    date: next,
                    type: "FX_REVALUATION_REVERSAL",
                    number: `${r.number}-R`,
                    party: "",
                    lines: lines(-1),
                  },
                ]
              : []),
          ];
        }),
    ].sort((x, y) => x.date.localeCompare(y.date) || x.number.localeCompare(y.number));
  const places = currencyDecimals(currency);
  const money = (v: Decimal) => (v.isZero() ? null : v.toFixed(places));
  return toCsv(
    ["entry", "date", "document_type", "customer_code", "account", "debit", "credit", "currency"],
    docs.flatMap((d) =>
      d.lines.map((l) => [
        d.number,
        d.date,
        d.type,
        d.party,
        l.account,
        money(l.debit),
        money(l.credit),
        currency,
      ]),
    ),
  );
}
