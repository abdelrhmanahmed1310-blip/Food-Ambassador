import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { isCalendarDate } from "@/lib/dates";
import { holdsAnyGrant } from "@/modules/access/authorize";
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
  if (!holdsAnyGrant(ctx.grants, "sales.view")) notFound();
  const today = businessDate(ctx.timeZone);
  const from =
    typeof sp.from === "string" && isCalendarDate(sp.from) ? sp.from : `${today.slice(0, 7)}-01`;
  const to = typeof sp.to === "string" && isCalendarDate(sp.to) ? sp.to : today;
  const [t, locale, money, rows] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
    vatSummary(ctx, { from, to: to < from ? from : to }),
  ]);
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
        {rows.length === 0 ? (
          <EmptyState title={t("tax.noSales")} />
        ) : (
          <Table label={t("tax.summaryTitle")}>
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
                <tr key={i} data-testid={`vat-${r.code?.code ?? "NONE"}`}>
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
        )}
      </div>
    </>
  );
}
