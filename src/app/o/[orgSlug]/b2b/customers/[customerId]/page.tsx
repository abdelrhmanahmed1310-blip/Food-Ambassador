import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CustomerReceiptForm } from "@/components/b2b/forms";
import { TextReasonForm } from "@/components/invoices/forms";
import {
  Badge,
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { customerAccount } from "@/modules/b2b/receivables";
import { businessDate } from "@/modules/inventory/rules";
import { PAYMENT_METHODS } from "@/modules/invoices/payables";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter } from "@/server/inventory-view";
import { recordCustomerReceiptAction, voidCustomerReceiptAction } from "../../actions";

export default async function CustomerPage({
  params,
}: PageProps<"/o/[orgSlug]/b2b/customers/[customerId]">) {
  const { orgSlug, customerId } = await params;
  if (!isUuid(customerId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const a = await notFoundOnAppError(customerAccount(ctx, customerId));
  const [t, locale, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const manage = hasPermission(ctx.grants, "b2b.manage");
  const c = a.customer;
  const amount = (v: { toString(): string }) => (
    <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>
  );
  return (
    <>
      <PageHeader
        title={`${c.code} — ${(locale === "ar" && c.nameAr) || c.name}`}
        description={t("b2b.customerHint")}
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("b2b.vatNumber"),
                value: <span className="ltr-value font-mono">{c.taxId ?? "—"}</span>,
              },
              { label: t("b2b.paymentTerms"), value: c.paymentTermsDays ?? "—" },
              { label: t("b2b.email"), value: <span className="ltr-value">{c.email ?? "—"}</span> },
            ]}
          />
        </Card>
        <Card title={t("payables.openInvoices")}>
          {a.open.length === 0 ? (
            <EmptyState title={t("payables.noOpenInvoices")} />
          ) : (
            <Table label={t("payables.openInvoices")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.number")}</Th>
                  <Th>{t("invoices.dueDate")}</Th>
                  <Th>{t("tax.gross")}</Th>
                  <Th>{t("b2b.received")}</Th>
                  <Th>{t("payables.open")}</Th>
                </tr>
              </thead>
              <tbody>
                {a.open.map((i) => (
                  <tr key={i.id} data-testid={`open-${i.number}`}>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/b2b/invoices/${i.id}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {i.number}
                      </Link>
                    </Td>
                    <Td>
                      <span className="ltr-value">{i.dueOn}</span>
                    </Td>
                    <Td className="tabular-nums">{amount(i.grossAmount)}</Td>
                    <Td className="tabular-nums">{amount(i.received)}</Td>
                    <Td className="font-medium tabular-nums">{amount(i.open)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title={t("b2b.receipts")}>
          {a.receipts.length === 0 ? (
            <EmptyState title={t("b2b.noReceipts")} />
          ) : (
            <ul className="space-y-2 text-sm">
              {a.receipts.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className="ltr-value font-mono text-xs">{r.number}</span>
                  <span className="ltr-value">{r.date.toISOString().slice(0, 10)}</span>
                  {amount(r.amount)}
                  {r.status === "VOIDED" ? (
                    <Badge tone="muted">{t("payables.statuses.VOIDED")}</Badge>
                  ) : null}
                  {r.unapplied.gt(0) ? (
                    <span className="text-muted text-xs">
                      {t("payables.unappliedAmount", { amount: money.money(r.unapplied) })}
                    </span>
                  ) : null}
                  {manage && r.status === "POSTED" ? (
                    <details className="w-full">
                      <summary className="text-primary cursor-pointer text-xs">
                        {t("payables.void")}
                      </summary>
                      <TextReasonForm
                        action={voidCustomerReceiptAction.bind(null, orgSlug, r.id)}
                        name="reason"
                        label={t("invoices.cancelReason")}
                        submitLabel={t("payables.void")}
                        variant="danger"
                      />
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {manage ? (
          <Card title={t("b2b.recordReceipt")}>
            <CustomerReceiptForm
              action={recordCustomerReceiptAction.bind(null, orgSlug, c.id)}
              methods={PAYMENT_METHODS.map((m) => ({
                value: m,
                label: t(`payables.methods.${m}`),
              }))}
              currency={ctx.baseCurrency}
              today={businessDate(ctx.timeZone)}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
