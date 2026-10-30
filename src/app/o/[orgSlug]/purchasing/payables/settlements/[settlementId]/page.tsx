import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { TextReasonForm } from "@/components/invoices/forms";
import { AllocateForm } from "@/components/invoices/payables-forms";
import {
  Alert,
  Badge,
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { getSettlement, openInvoicesOf } from "@/modules/invoices/payables";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter } from "@/server/inventory-view";
import { allocateSettlementAction, voidSettlementAction } from "../../actions";

export default async function SettlementPage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/payables/settlements/[settlementId]">) {
  const { orgSlug, settlementId } = await params;
  if (!isUuid(settlementId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const s = await notFoundOnAppError(getSettlement(ctx, settlementId));
  const canPay = hasPermission(ctx.grants, "payments.manage") && s.status === "POSTED";
  const [t, locale, format, money, open] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency),
    canPay && s.unapplied.gt(0) ? openInvoicesOf(ctx, s.supplier.id) : Promise.resolve([]),
  ]);
  const amount = (v: Decimal) => (
    <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>
  );
  const dt = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const base = `/o/${orgSlug}/purchasing`;
  return (
    <>
      <PageHeader
        title={s.number}
        description={`${t(`payables.kinds.${s.kind}`)} · ${s.supplier.code} — ${(locale === "ar" && s.supplier.nameAr) || s.supplier.name}`}
        actions={
          <Badge tone={s.status === "POSTED" ? "success" : "muted"}>
            {t(`payables.statuses.${s.status}`)}
          </Badge>
        }
      />
      <div className="space-y-6">
        {s.status === "VOIDED" ? (
          <Alert tone="info">{t("payables.voidedBecause", { reason: s.voidReason ?? "" })}</Alert>
        ) : null}
        <Card>
          <DescriptionList
            items={[
              {
                label: t("purchasing.supplier"),
                value: (
                  <Link
                    href={`${base}/payables/${s.supplier.id}`}
                    className="text-primary hover:underline"
                  >
                    {s.supplier.code}
                  </Link>
                ),
              },
              {
                label: t("payables.date"),
                value: <span className="ltr-value">{s.date.toISOString().slice(0, 10)}</span>,
              },
              ...(s.kind === "PAYMENT"
                ? [
                    {
                      label: t("payables.method"),
                      value: s.method ? t(`payables.methods.${s.method}`) : "—",
                    },
                  ]
                : [
                    {
                      label: t("payables.creditNoteNo"),
                      value: <span className="ltr-value font-mono">{s.supplierDocumentNo}</span>,
                    },
                    { label: t("tax.net"), value: amount(s.netAmount as Decimal) },
                    {
                      label: t("tax.vat"),
                      value: (
                        <span className="ltr-value">
                          {amount(s.taxAmount)} {s.taxCode ? `(${s.taxCode.code})` : ""}
                        </span>
                      ),
                    },
                  ]),
              { label: t("payables.amount"), value: amount(s.amount) },
              { label: t("payables.applied"), value: amount(s.applied) },
              {
                label: t("payables.unapplied"),
                value: <span data-testid="unapplied">{amount(s.unapplied)}</span>,
              },
              { label: t("payables.reference"), value: s.reference ?? "—" },
              {
                label: s.kind === "PAYMENT" ? t("common.note") : t("payables.creditReason"),
                value: s.note ?? "—",
              },
              {
                label: t("purchasing.createdBy"),
                value: (
                  <>
                    <bdi>{s.names.createdBy ?? "—"}</bdi> · <bdi>{dt(s.createdAt)}</bdi>
                  </>
                ),
              },
              ...(s.voidedAt
                ? [
                    {
                      label: t("payables.voidedBy"),
                      value: (
                        <>
                          <bdi>{s.names.voidedBy ?? "—"}</bdi> · <bdi>{dt(s.voidedAt)}</bdi>
                        </>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>
        <Card title={t("payables.allocations")}>
          {s.allocations.length === 0 ? (
            <EmptyState title={t("payables.noAllocations")} />
          ) : (
            <Table label={t("payables.allocations")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.number")}</Th>
                  <Th>{t("invoices.supplierInvoiceNo")}</Th>
                  <Th>{t("payables.amount")}</Th>
                </tr>
              </thead>
              <tbody>
                {s.allocations.map((a) => (
                  <tr key={a.id}>
                    <Td>
                      <Link
                        href={`${base}/invoices/${a.invoice.id}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {a.invoice.number}
                      </Link>
                    </Td>
                    <Td>
                      <span className="ltr-value font-mono text-xs">
                        {a.invoice.supplierInvoiceNo}
                      </span>
                    </Td>
                    <Td className="tabular-nums">{amount(a.amount)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {canPay && s.unapplied.gt(0) ? (
          <Card title={t("payables.applyRest")}>
            <AllocateForm
              action={allocateSettlementAction.bind(null, orgSlug, s.id)}
              invoices={open.map((i) => ({
                id: i.id,
                label: `${i.number} · ${i.supplierInvoiceNo} · ${t("payables.dueOn", { date: i.dueOn })}`,
                open: money.money(i.open),
              }))}
            />
          </Card>
        ) : null}
        {canPay ? (
          <Card title={t("payables.void")}>
            <p className="text-muted mb-3 text-sm">{t("payables.voidHint")}</p>
            <TextReasonForm
              action={voidSettlementAction.bind(null, orgSlug, s.id)}
              name="reason"
              label={t("invoices.cancelReason")}
              submitLabel={t("payables.void")}
              variant="danger"
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
