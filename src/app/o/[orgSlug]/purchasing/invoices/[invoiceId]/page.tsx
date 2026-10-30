import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import {
  InvoiceStatusBadge,
  LineMatchBadge,
  MatchBadge,
  PaymentStatusBadge,
} from "@/components/invoices/badges";
import {
  ChargeLineForm,
  GoodsLineForm,
  InvoiceForm,
  TextReasonForm,
} from "@/components/invoices/forms";
import {
  Alert,
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getInvoice, invoiceFormOptions, uninvoicedReceiptLines } from "@/modules/invoices/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, productName, quantityFormatter } from "@/server/inventory-view";
import {
  addChargeLineAction,
  addGoodsLineAction,
  approveInvoiceAction,
  cancelInvoiceAction,
  postInvoiceAction,
  removeInvoiceLineAction,
  updateInvoiceAction,
} from "../actions";

export default async function InvoicePage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/invoices/[invoiceId]">) {
  const { orgSlug, invoiceId } = await params;
  if (!isUuid(invoiceId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const inv = await notFoundOnAppError(getInvoice(ctx, invoiceId));
  const [t, locale, format, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const [open, options] = inv.can.edit
    ? await Promise.all([uninvoicedReceiptLines(ctx, inv.supplier.id), invoiceFormOptions(ctx)])
    : [[], { suppliers: [], taxCodes: [] }];
  // Receipt lines partly on this invoice are offered for what is still open beyond it.
  const onThis = new Set(inv.lines.map((l) => l.receiptLineId));
  const taxCodes = options.taxCodes.map((c) => ({
    value: c.id,
    label: `${c.code} — ${(locale === "ar" && c.nameAr) || c.name}`,
  }));
  const dt = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const who = (name: string | null, at: Date | null) => (
    <>
      <bdi>{name ?? "—"}</bdi> · <bdi>{dt(at)}</bdi>
    </>
  );
  const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? "—";
  const pct = (r: { toString(): string } | null) =>
    r === null
      ? "—"
      : `${(Number(r.toString()) * 100).toLocaleString("en", { maximumFractionDigits: 4 })} %`;
  const amount = (v: { toString(): string } | null) => (
    <span className="ltr-value whitespace-nowrap">{v === null ? "—" : money.money(v)}</span>
  );
  return (
    <>
      <PageHeader
        title={inv.number}
        description={`${inv.supplier.code} — ${(locale === "ar" && inv.supplier.nameAr) || inv.supplier.name}`}
        actions={
          <span className="flex gap-2">
            {inv.status !== "CANCELLED" ? <MatchBadge status={inv.matchStatus} /> : null}
            {inv.paymentStatus ? <PaymentStatusBadge status={inv.paymentStatus} /> : null}
            <InvoiceStatusBadge status={inv.status} />
          </span>
        }
      />
      <div className="space-y-6">
        {inv.status === "CANCELLED" ? (
          <Alert tone="info">
            {t("invoices.cancelledBecause", { reason: inv.cancelReason ?? "" })}
          </Alert>
        ) : null}
        {inv.status === "DRAFT" && inv.lines.length > 0 && !inv.totalOk ? (
          <Alert tone="error">
            {t("invoices.totalMismatch", {
              printed: money.money(inv.printedGross),
              computed: money.money(inv.grossAmount),
            })}
          </Alert>
        ) : null}
        {inv.status === "DRAFT" && inv.matchStatus === "EXCEPTION" ? (
          <Alert tone="info">
            {inv.exceptionApprovedAt
              ? t("invoices.exceptionApproved")
              : t("invoices.exceptionNeedsApproval")}
          </Alert>
        ) : null}
        <Card>
          <DescriptionList
            items={[
              {
                label: t("invoices.supplierInvoiceNo"),
                value: <span className="ltr-value font-mono">{inv.supplierInvoiceNo}</span>,
              },
              {
                label: t("invoices.supplierVat"),
                value: <span className="ltr-value font-mono">{inv.supplier.taxId ?? "—"}</span>,
              },
              {
                label: t("invoices.invoiceDate"),
                value: <span className="ltr-value">{day(inv.invoiceDate)}</span>,
              },
              {
                label: t("invoices.dueDate"),
                value: <span className="ltr-value">{day(inv.dueDate)}</span>,
              },
              { label: t("invoices.printedGross"), value: amount(inv.printedGross) },
              { label: t("tax.net"), value: amount(inv.netAmount) },
              { label: t("tax.vat"), value: amount(inv.taxAmount) },
              { label: t("tax.gross"), value: amount(inv.grossAmount) },
              ...(inv.status === "POSTED"
                ? [
                    { label: t("payables.settled"), value: amount(inv.settled) },
                    {
                      label: t("payables.open"),
                      value: <span data-testid="invoice-open">{amount(inv.open)}</span>,
                    },
                  ]
                : []),
              { label: t("purchasing.createdBy"), value: who(inv.names.createdBy, inv.createdAt) },
              ...(inv.exceptionApprovedAt
                ? [
                    {
                      label: t("invoices.approvedBy"),
                      value: (
                        <>
                          {who(inv.names.approvedBy, inv.exceptionApprovedAt)}
                          <span className="text-muted block text-xs">{inv.exceptionNote}</span>
                        </>
                      ),
                    },
                  ]
                : []),
              ...(inv.postedAt
                ? [{ label: t("invoices.postedBy"), value: who(inv.names.postedBy, inv.postedAt) }]
                : []),
              ...(inv.cancelledAt
                ? [
                    {
                      label: t("invoices.cancelledBy"),
                      value: who(inv.names.cancelledBy, inv.cancelledAt),
                    },
                  ]
                : []),
              { label: t("common.note"), value: inv.note ?? "—" },
            ]}
          />
        </Card>

        <Card title={t("invoices.lines")}>
          {inv.lines.length === 0 ? (
            <EmptyState title={t("invoices.noLines")} />
          ) : (
            <Table label={t("invoices.lines")}>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>{t("invoices.description")}</Th>
                  <Th>{t("common.quantity")}</Th>
                  <Th>{t("invoices.invoicePrice")}</Th>
                  <Th>{t("invoices.orderPrice")}</Th>
                  <Th>{t("tax.net")}</Th>
                  <Th>{t("tax.rate")}</Th>
                  <Th>{t("tax.vat")}</Th>
                  <Th>{t("invoices.match")}</Th>
                  {inv.can.edit ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.id} data-testid={`invoice-line-${l.lineNo}`}>
                    <Td className="tabular-nums">{l.lineNo}</Td>
                    <Td>
                      <bdi>{l.description}</bdi>
                      {l.receiptLine ? (
                        <Link
                          href={`/o/${orgSlug}/purchasing/receipts/${l.receiptLine.receipt.id}`}
                          className="ltr-value text-primary block font-mono text-xs hover:underline"
                        >
                          {l.receiptLine.receipt.number}
                        </Link>
                      ) : null}
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {fmt(l.quantity)} {l.uom?.code ?? ""}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {money.unitCost(l.unitPrice)}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {l.orderedUnitPrice ? money.unitCost(l.orderedUnitPrice) : "—"}
                      </span>
                    </Td>
                    <Td className="tabular-nums">{amount(l.netAmount)}</Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value">
                        {l.taxCode ? `${l.taxCode.code} ${pct(l.taxRate)}` : "—"}
                      </span>
                    </Td>
                    <Td className="tabular-nums">{amount(l.taxAmount)}</Td>
                    <Td>
                      <LineMatchBadge match={l.match} />
                      {l.priceVariance && !l.priceVariance.isZero() ? (
                        <span className="text-muted block text-xs">
                          {t("invoices.priceVariance")}: {amount(l.priceVariance)}
                        </span>
                      ) : null}
                      {l.quantityVariance && !l.quantityVariance.isZero() ? (
                        <span className="text-muted block text-xs">
                          {t("invoices.quantityVariance")}:{" "}
                          <span className="ltr-value">
                            {fmt(l.quantityVariance)} {l.uom?.code ?? ""}
                          </span>
                        </span>
                      ) : null}
                    </Td>
                    {inv.can.edit ? (
                      <Td>
                        <ConfirmActionButton
                          action={removeInvoiceLineAction.bind(null, orgSlug, inv.id, l.id)}
                          label={t("purchasing.removeLine")}
                          variant="secondary"
                        />
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {inv.allocations.length > 0 ? (
          <Card title={t("payables.paymentsAndCredits")}>
            <ul className="space-y-1 text-sm">
              {inv.allocations.map((a) => (
                <li
                  key={a.id}
                  className={a.settlement.status === "VOIDED" ? "text-muted line-through" : ""}
                >
                  <Link
                    href={`/o/${orgSlug}/purchasing/payables/settlements/${a.settlement.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {a.settlement.number}
                  </Link>{" "}
                  · {t(`payables.kinds.${a.settlement.kind}`)} ·{" "}
                  <span className="ltr-value">{day(a.settlement.date)}</span> · {amount(a.amount)}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {inv.can.edit ? (
          <>
            <Card title={t("invoices.receivedToInvoice")}>
              <p className="text-muted mb-3 text-sm">{t("invoices.receivedToInvoiceHint")}</p>
              {open.length === 0 ? (
                <EmptyState title={t("invoices.nothingToInvoice")} />
              ) : (
                <div className="space-y-3">
                  {open.map((l) => (
                    <GoodsLineForm
                      key={l.id}
                      action={addGoodsLineAction.bind(null, orgSlug, inv.id)}
                      receiptLineId={l.id}
                      label={`${l.receipt.number} · ${l.product.sku} — ${productName(l.product, locale)} · ${t("invoices.openQuantity", { quantity: fmt(l.open), unit: l.uom.code })}${onThis.has(l.id) ? ` · ${t("invoices.partlyOnThis")}` : ""}`}
                      quantity={l.open.toFixed()}
                      unit={l.uom.code}
                      unitPrice={l.unitPrice.toFixed()}
                      taxCodes={taxCodes}
                    />
                  ))}
                </div>
              )}
            </Card>
            <Card title={t("invoices.charges")}>
              <p className="text-muted mb-3 text-sm">{t("invoices.chargesHint")}</p>
              <ChargeLineForm
                action={addChargeLineAction.bind(null, orgSlug, inv.id)}
                taxCodes={taxCodes}
              />
            </Card>
            <Card title={t("invoices.header")}>
              <InvoiceForm
                action={updateInvoiceAction.bind(null, orgSlug, inv.id)}
                currency={ctx.baseCurrency}
                submitLabel={t("common.save")}
                defaults={{
                  supplierInvoiceNo: inv.supplierInvoiceNo,
                  invoiceDate: day(inv.invoiceDate),
                  dueDate: inv.dueDate ? day(inv.dueDate) : "",
                  printedGross: inv.printedGross.toFixed(),
                  note: inv.note ?? "",
                }}
              />
            </Card>
          </>
        ) : null}

        {inv.can.approve ? (
          <Card title={t("invoices.approve")}>
            <p className="text-muted mb-3 text-sm">{t("invoices.approveHint")}</p>
            <TextReasonForm
              action={approveInvoiceAction.bind(null, orgSlug, inv.id)}
              name="note"
              label={t("invoices.approvalNote")}
              submitLabel={t("invoices.approve")}
            />
          </Card>
        ) : null}
        {inv.can.post ? (
          <Card>
            <p className="text-muted mb-3 text-sm">{t("invoices.postHint")}</p>
            <ConfirmActionButton
              action={postInvoiceAction.bind(null, orgSlug, inv.id)}
              label={t("invoices.post")}
              confirmMessage={t("invoices.confirmPost")}
              variant="primary"
            />
          </Card>
        ) : null}
        {inv.can.cancel ? (
          <Card title={t("invoices.cancel")}>
            <TextReasonForm
              action={cancelInvoiceAction.bind(null, orgSlug, inv.id)}
              name="reason"
              label={t("invoices.cancelReason")}
              submitLabel={t("invoices.cancel")}
              variant="danger"
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
