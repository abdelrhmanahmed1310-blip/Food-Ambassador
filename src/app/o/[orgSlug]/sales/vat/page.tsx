import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { isCalendarDate } from "@/lib/dates";
import { Decimal } from "@/lib/decimal";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { b2bOutputVat } from "@/modules/b2b/service";
import { inputVatSummary } from "@/modules/invoices/service";
import { businessDate } from "@/modules/inventory/rules";
import { vatSummary } from "@/modules/tax/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";

export default async function VatSummaryPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/sales/vat">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const canSales = holdsAnyGrant(ctx.grants, "sales.view");
  const canInvoices = hasPermission(ctx.grants, "invoices.view");
  const canB2b = hasPermission(ctx.grants, "b2b.view");
  if (!canSales && !canInvoices && !canB2b) notFound();
  const today = businessDate(ctx.timeZone);
  const from =
    typeof sp.from === "string" && isCalendarDate(sp.from) ? sp.from : `${today.slice(0, 7)}-01`;
  const to = typeof sp.to === "string" && isCalendarDate(sp.to) ? sp.to : today;
  const period = { from, to: to < from ? from : to };
  const [t, locale, money, rows, input, b2b] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
    canSales ? vatSummary(ctx, period) : Promise.resolve(null),
    canInvoices ? inputVatSummary(ctx, period) : Promise.resolve(null),
    canB2b ? b2bOutputVat(ctx, period) : Promise.resolve(null),
  ]);
  const total = (list: Array<{ tax: { toString(): string } | null }>) =>
    list.reduce((a, r) => a.plus(r.tax?.toString() ?? "0"), new Decimal(0));
  const outputVat = rows || b2b ? total([...(rows ?? []), ...(b2b ?? [])]) : null;
  const inputVat = input?.reclaimable ? total(input.rows) : null;
  type Row = {
    code: { code: string; name: string; nameAr: string | null } | null;
    rate: { toString(): string } | null;
    lines: number;
    net: { toString(): string } | null;
    tax: { toString(): string } | null;
    gross: { toString(): string } | null;
  };
  const vatTable = (rows: Row[], label: string, testId: string) => (
    <Table label={label}>
      <thead>
        <tr>
          <Th>{t("tax.code")}</Th>
          <Th>{t("tax.rate")}</Th>
          <Th>{t("sales.lines")}</Th>
          <Th>{t("tax.net")}</Th>
          <Th>{t("tax.vat")}</Th>
          <Th>{t("tax.gross")}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} data-testid={`${testId}-${r.code?.code ?? "NONE"}`}>
            <Td>
              {r.code
                ? `${r.code.code} — ${(locale === "ar" && r.code.nameAr) || r.code.name}`
                : t("tax.notTaxed")}
            </Td>
            <Td className="tabular-nums">
              <span className="ltr-value">{pct(r.rate)}</span>
            </Td>
            <Td className="tabular-nums">{r.lines}</Td>
            <Td className="tabular-nums">
              <span className="ltr-value whitespace-nowrap">
                {r.net ? money.money(r.net) : "—"}
              </span>
            </Td>
            <Td className="tabular-nums">
              <span className="ltr-value whitespace-nowrap">
                {r.tax ? money.money(r.tax) : "—"}
              </span>
            </Td>
            <Td className="tabular-nums">
              <span className="ltr-value whitespace-nowrap">
                {r.gross ? money.money(r.gross) : "—"}
              </span>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
  const pct = (r: { toString(): string } | null) =>
    r === null
      ? "—"
      : `${(Number(r.toString()) * 100).toLocaleString("en", { maximumFractionDigits: 4 })} %`;
  return (
    <>
      <PageHeader title={t("tax.summaryTitle")} description={t("tax.summaryHint")} />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("tax.from")}</span>
            <input
              type="date"
              name="from"
              defaultValue={from}
              className="border-border bg-surface rounded-md border px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("tax.to")}</span>
            <input
              type="date"
              name="to"
              defaultValue={to}
              className="border-border bg-surface rounded-md border px-3 py-2"
            />
          </label>
          <button
            type="submit"
            className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
          >
            {t("common.apply")}
          </button>
        </form>
        <Alert tone="info">{t("tax.summaryNote")}</Alert>
        {rows ? (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">{t("tax.outputVat")}</h2>
            {rows.length === 0 ? (
              <EmptyState title={t("tax.noSales")} />
            ) : (
              vatTable(rows, t("tax.outputVat"), "vat")
            )}
          </section>
        ) : null}
        {b2b && b2b.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">{t("b2b.outputVat")}</h2>
            {vatTable(b2b, t("b2b.outputVat"), "vat-b2b")}
          </section>
        ) : null}
        {input ? (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">{t("tax.inputVat")}</h2>
            {!input.reclaimable ? <Alert tone="info">{t("tax.inputNotReclaimable")}</Alert> : null}
            {input.rows.length === 0 ? (
              <EmptyState title={t("tax.noInvoices")} />
            ) : (
              vatTable(input.rows, t("tax.inputVat"), "vat-in")
            )}
          </section>
        ) : null}
        {outputVat && inputVat ? (
          <Card>
            <p className="text-sm" data-testid="vat-net">
              {t("tax.netEstimate", {
                output: money.money(outputVat),
                input: money.money(inputVat),
                net: money.money(outputVat.minus(inputVat)),
              })}
            </p>
          </Card>
        ) : null}
      </div>
    </>
  );
}
