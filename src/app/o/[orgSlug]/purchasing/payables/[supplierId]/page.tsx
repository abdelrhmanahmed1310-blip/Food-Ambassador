import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CreditNoteForm, PaymentForm } from "@/components/invoices/payables-forms";
import {
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isCalendarDate } from "@/lib/dates";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { businessDate } from "@/modules/inventory/rules";
import { PAYMENT_METHODS, supplierStatement } from "@/modules/invoices/payables";
import { invoiceFormOptions } from "@/modules/invoices/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter } from "@/server/inventory-view";
import { recordCreditNoteAction, recordPaymentAction } from "../actions";

export default async function SupplierStatementPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/payables/[supplierId]">) {
  const { orgSlug, supplierId } = await params;
  if (!isUuid(supplierId)) notFound();
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const today = businessDate(ctx.timeZone);
  const from =
    typeof sp.from === "string" && isCalendarDate(sp.from)
      ? sp.from
      : `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  const to = typeof sp.to === "string" && isCalendarDate(sp.to) && sp.to >= from ? sp.to : today;
  const st = await notFoundOnAppError(supplierStatement(ctx, supplierId, { from, to }));
  const canPay = hasPermission(ctx.grants, "payments.manage");
  const [t, locale, money, options] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
    canPay && hasPermission(ctx.grants, "invoices.manage")
      ? invoiceFormOptions(ctx)
      : Promise.resolve({ suppliers: [], taxCodes: [] }),
  ]);
  const base = `/o/${orgSlug}/purchasing`;
  const amount = (v: Decimal) => (
    <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>
  );
  const docLink = (e: { kind: string; id: string; number: string }) => (
    <Link
      href={
        e.kind === "INVOICE" ? `${base}/invoices/${e.id}` : `${base}/payables/settlements/${e.id}`
      }
      className="ltr-value text-primary font-mono text-xs hover:underline"
    >
      {e.number}
    </Link>
  );
  const openOptions = st.open.map((i) => ({
    id: i.id,
    label: `${i.number} · ${i.supplierInvoiceNo} · ${t("payables.dueOn", { date: i.dueOn })}`,
    open: money.money(i.open),
  }));
  const taxCodes = options.taxCodes.map((c) => ({
    value: c.id,
    label: `${c.code} — ${(locale === "ar" && c.nameAr) || c.name}`,
  }));
  return (
    <>
      <PageHeader
        title={`${st.supplier.code} — ${(locale === "ar" && st.supplier.nameAr) || st.supplier.name}`}
        description={t("payables.statementHint")}
      />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          {(
            [
              ["from", t("tax.from"), from],
              ["to", t("tax.to"), to],
            ] as const
          ).map(([name, label, value]) => (
            <label key={name} className="text-sm">
              <span className="mb-1 block font-medium">{label}</span>
              <input
                type="date"
                name={name}
                defaultValue={value}
                className="border-border bg-surface rounded-md border px-3 py-2"
              />
            </label>
          ))}
          <button
            type="submit"
            className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
          >
            {t("common.apply")}
          </button>
        </form>
        <Card>
          <DescriptionList
            items={[
              { label: t("payables.openingBalance"), value: amount(st.opening) },
              {
                label: t("payables.closingBalance"),
                value: <span data-testid="closing-balance">{amount(st.closing)}</span>,
              },
              {
                label: t("invoices.supplierVat"),
                value: <span className="ltr-value font-mono">{st.supplier.taxId ?? "—"}</span>,
              },
            ]}
          />
        </Card>

        <Card title={t("payables.statement")}>
          {st.lines.length === 0 ? (
            <EmptyState title={t("payables.noEntries")} />
          ) : (
            <Table label={t("payables.statement")}>
              <thead>
                <tr>
                  <Th>{t("payables.date")}</Th>
                  <Th>{t("payables.document")}</Th>
                  <Th>{t("payables.reference")}</Th>
                  <Th>{t("payables.charge")}</Th>
                  <Th>{t("payables.credit")}</Th>
                  <Th>{t("payables.balance")}</Th>
                </tr>
              </thead>
              <tbody>
                {st.lines.map((l) => (
                  <tr key={`${l.kind}-${l.id}`}>
                    <Td className="whitespace-nowrap">
                      <span className="ltr-value">{l.date}</span>
                    </Td>
                    <Td>
                      {docLink(l)}
                      <span className="text-muted block text-xs">
                        {t(`payables.kinds.${l.kind}`)}
                      </span>
                    </Td>
                    <Td>
                      <span className="ltr-value font-mono text-xs">{l.reference ?? "—"}</span>
                    </Td>
                    <Td className="tabular-nums">{l.charge.isZero() ? "—" : amount(l.charge)}</Td>
                    <Td className="tabular-nums">{l.credit.isZero() ? "—" : amount(l.credit)}</Td>
                    <Td className="tabular-nums">{amount(l.balance)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title={t("payables.openInvoices")}>
          {st.open.length === 0 ? (
            <EmptyState title={t("payables.noOpenInvoices")} />
          ) : (
            <Table label={t("payables.openInvoices")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.number")}</Th>
                  <Th>{t("invoices.supplierInvoiceNo")}</Th>
                  <Th>{t("invoices.dueDate")}</Th>
                  <Th>{t("tax.gross")}</Th>
                  <Th>{t("payables.settled")}</Th>
                  <Th>{t("payables.open")}</Th>
                </tr>
              </thead>
              <tbody>
                {st.open.map((i) => (
                  <tr key={i.id}>
                    <Td>{docLink({ kind: "INVOICE", id: i.id, number: i.number })}</Td>
                    <Td>
                      <span className="ltr-value font-mono text-xs">{i.supplierInvoiceNo}</span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span className="ltr-value">{i.dueOn}</span>
                    </Td>
                    <Td className="tabular-nums">{amount(i.grossAmount)}</Td>
                    <Td className="tabular-nums">{amount(i.settled)}</Td>
                    <Td className="font-medium tabular-nums">{amount(i.open)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {st.unapplied.length > 0 ? (
          <Card title={t("payables.onAccount")}>
            <ul className="space-y-1 text-sm">
              {st.unapplied.map((s) => (
                <li key={s.id}>
                  {docLink(s)} ·{" "}
                  <span className="ltr-value">{s.date.toISOString().slice(0, 10)}</span> ·{" "}
                  {t("payables.unappliedAmount", { amount: money.money(s.unapplied) })}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {canPay ? (
          <>
            <Card title={t("payables.recordPayment")}>
              <PaymentForm
                action={recordPaymentAction.bind(null, orgSlug, st.supplier.id)}
                methods={PAYMENT_METHODS.map((m) => ({
                  value: m,
                  label: t(`payables.methods.${m}`),
                }))}
                invoices={openOptions}
                currency={ctx.baseCurrency}
                today={today}
              />
            </Card>
            <Card title={t("payables.recordCreditNote")}>
              <CreditNoteForm
                action={recordCreditNoteAction.bind(null, orgSlug, st.supplier.id)}
                taxCodes={taxCodes}
                invoices={openOptions}
                currency={ctx.baseCurrency}
                today={today}
              />
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}
