import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CustomerReceiptForm, EInvoiceDetailsForm } from "@/components/b2b/forms";
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
import { currencyChoices } from "@/modules/fx/rules";
import { listCompanies } from "@/modules/organizations/companies";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyIn } from "@/server/fx-view";
import {
  recordCustomerReceiptAction,
  updateEInvoiceDetailsAction,
  voidCustomerReceiptAction,
} from "../../actions";

export default async function CustomerPage({
  params,
}: PageProps<"/o/[orgSlug]/b2b/customers/[customerId]">) {
  const { orgSlug, customerId } = await params;
  if (!isUuid(customerId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const a = await notFoundOnAppError(customerAccount(ctx, customerId));
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  // Each document in its own currency (ADR-054).
  const moneyOf = await moneyIn([
    ctx.baseCurrency,
    a.customer.currency ?? ctx.baseCurrency,
    ...a.open.map((i) => i.currency),
    ...a.receipts.map((r) => r.currency),
  ]);
  const money = moneyOf(a.customer.currency ?? ctx.baseCurrency);
  const manage = hasPermission(ctx.grants, "b2b.manage");
  const c = a.customer;
  const amount = (v: { toString(): string }, currency?: string) => (
    <span className="ltr-value whitespace-nowrap">
      {(currency ? moneyOf(currency) : money).money(v)}
    </span>
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
              { label: t("fx.currency"), value: c.currency ?? ctx.baseCurrency },
              { label: t("b2b.email"), value: <span className="ltr-value">{c.email ?? "—"}</span> },
            ]}
          />
        </Card>
        {manage ? (
          <Card title={t("b2b.eInvoiceDetails")}>
            <EInvoiceDetailsForm
              action={updateEInvoiceDetailsAction.bind(null, orgSlug, c.id)}
              values={{
                taxId: c.taxId,
                crNumber: c.crNumber,
                street: c.street,
                buildingNumber: c.buildingNumber,
                district: c.district,
                city: c.city,
                postalCode: c.postalCode,
                countryCode: c.countryCode,
              }}
            />
          </Card>
        ) : null}
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
                    <Td className="tabular-nums">{amount(i.grossAmount, i.currency)}</Td>
                    <Td className="tabular-nums">{amount(i.received, i.currency)}</Td>
                    <Td className="font-medium tabular-nums">{amount(i.open, i.currency)}</Td>
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
                  {amount(r.amount, r.currency)}
                  {r.status === "VOIDED" ? (
                    <Badge tone="muted">{t("payables.statuses.VOIDED")}</Badge>
                  ) : null}
                  {r.unapplied.gt(0) ? (
                    <span className="text-muted text-xs">
                      {t("payables.unappliedAmount", {
                        amount: moneyOf(r.currency).money(r.unapplied),
                      })}
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
              currency={c.currency ?? ctx.baseCurrency}
              currencies={currencyChoices(ctx.baseCurrency)}
              companies={(await listCompanies(ctx)).map((x) => ({
                value: x.id,
                label: `${x.code} — ${x.name}`,
              }))}
              today={businessDate(ctx.timeZone)}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
