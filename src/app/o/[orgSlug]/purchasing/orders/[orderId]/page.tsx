import Link from "next/link";
import { notFound } from "next/navigation";
import { AttachmentsCard } from "@/components/attachments/attachments-card";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ApprovalSteps } from "@/components/approvals/steps";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { OrderStatusBadge, ReceiptStatusBadge } from "@/components/procurement/badges";
import {
  OrderHeaderForm,
  OrderLineEditForm,
  OrderLineForm,
  ReasonForm,
} from "@/components/procurement/forms";
import {
  Alert,
  Card,
  DescriptionList,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { PrintButton } from "@/components/ui/print-button";
import { buttonClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { listProductOptions, listUnits } from "@/modules/catalog/service";
import { getOrder, productsNamed, purchasingWarehouseOptions } from "@/modules/procurement/orders";
import { supplierOptions } from "@/modules/procurement/suppliers";
import { currencyChoices } from "@/modules/fx/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { fxItems } from "@/server/fx-view";
import {
  moneyFormatter,
  productName,
  productOptions,
  quantityFormatter,
  unitOptions,
} from "@/server/inventory-view";
import {
  addOrderLineAction,
  approveOrderAction,
  cancelOrderAction,
  closeOrderAction,
  rejectOrderAction,
  removeOrderLineAction,
  reviseOrderAction,
  updateOrderLineAction,
  submitOrderAction,
  updateOrderHeaderAction,
} from "../../actions";

export default async function OrderPage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/orders/[orderId]">) {
  const { orgSlug, orderId } = await params;
  if (!isUuid(orderId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const order = await notFoundOnAppError(getOrder(ctx, orderId));
  const [t, locale, format, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    moneyFormatter(order.currency),
  ]);
  // Base amounts are in the order's company's currency (ADR-086).
  const bookCurrency = order.company?.currency ?? ctx.groupCurrency;
  const fx = await fxItems(bookCurrency, order, {
    label: t("fx.totalInBase", { currency: bookCurrency }),
    value: order.totalAmountBase,
  });
  const editing = order.can.edit;
  const [products, units, suppliers, warehouses] = editing
    ? await Promise.all([
        listProductOptions(ctx),
        listUnits(ctx),
        supplierOptions(ctx),
        purchasingWarehouseOptions(ctx, "purchasing.manage"),
      ])
    : [[], [], [], []];
  const dt = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  /** Name and time as separate bidi runs, so they never interleave in Arabic. */
  const who = (name: string | null, at: Date | null, extra?: string) => (
    <>
      <bdi>{name ?? "—"}</bdi>
      {extra ? <> ({extra})</> : null} · <bdi>{dt(at)}</bdi>
    </>
  );
  const supplierName = (locale === "ar" && order.supplier.nameAr) || order.supplier.name;
  // Products named in revision history (a removed line is no longer on the order).
  const historyIds = [
    ...new Set(order.revisions.flatMap((r) => r.changes.map((c) => c.productId))),
  ].filter((id) => !order.lines.some((l) => l.productId === id));
  const productsById = new Map<string, { sku: string; nameEn: string; nameAr: string | null }>([
    ...order.lines.map((l) => [l.productId, l.product] as const),
    ...(historyIds.length > 0
      ? (await productsNamed(ctx, historyIds)).map((p) => [p.id, p] as const)
      : []),
  ]);
  return (
    <>
      <PageHeader
        title={order.number}
        description={
          order.quotation ? (
            <>
              {supplierName} ·{" "}
              <Link
                href={`/o/${orgSlug}/purchasing/rfqs/${order.quotation.rfq.id}`}
                className="text-primary hover:underline"
              >
                {t("rfqs.fromRfq", { number: order.quotation.rfq.number })}
              </Link>
            </>
          ) : (
            supplierName
          )
        }
        actions={
          <>
            <OrderStatusBadge status={order.status} />
            {order.revision > 0 ? (
              <span className="text-muted text-sm" data-testid="po-revision">
                {t("purchasing.revisionLabel", { revision: order.revision })}
              </span>
            ) : null}
            {order.status !== "DRAFT" ? <PrintButton label={t("purchasing.print")} /> : null}
            {order.status !== "DRAFT" ? (
              <a
                href={`/o/${orgSlug}/purchasing/orders/${order.id}/pdf`}
                className={`${buttonClass("secondary")} print:hidden`}
                data-testid="po-pdf"
              >
                {t("documents.pdf")}
              </a>
            ) : null}
            {order.can.receive ? (
              <span className="print:hidden">
                <LinkButton href={`/o/${orgSlug}/purchasing/orders/${order.id}/receive`}>
                  {t("purchasing.receive")}
                </LinkButton>
              </span>
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        {order.rejectionNote && order.status === "DRAFT" ? (
          <Alert tone="error">{t("purchasing.rejectedNote", { note: order.rejectionNote })}</Alert>
        ) : null}
        <Card>
          <DescriptionList
            items={[
              {
                label: t("purchasing.supplier"),
                value: (
                  <Link
                    href={`/o/${orgSlug}/suppliers/${order.supplier.id}`}
                    className="text-primary hover:underline"
                  >
                    {order.supplier.code} — {supplierName}
                  </Link>
                ),
              },
              {
                label: t("purchasing.deliverTo"),
                value: `${order.warehouse.code} — ${order.warehouse.name}`,
              },
              {
                label: t("purchasing.expectedOn"),
                value: order.expectedOn?.toISOString().slice(0, 10) ?? "—",
              },
              {
                label: t("purchasing.total"),
                value: (
                  <span className="ltr-value tabular-nums">{money.money(order.totalAmount)}</span>
                ),
              },
              ...fx,
              {
                label: t("purchasing.createdBy"),
                value: who(order.names.createdBy, order.createdAt),
              },
              ...(order.submittedAt
                ? [
                    {
                      label: t("purchasing.submittedBy"),
                      value: who(order.names.submittedBy, order.submittedAt),
                    },
                  ]
                : []),
              ...(order.approvedAt
                ? [
                    {
                      label: t("purchasing.approvedBy"),
                      value: who(
                        order.names.approvedBy,
                        order.approvedAt,
                        order.autoApproved ? t("purchasing.autoApproved") : undefined,
                      ),
                    },
                  ]
                : []),
              ...(order.closedAt
                ? [
                    {
                      label: t("purchasing.closedBy"),
                      value: (
                        <>
                          {who(order.names.closedBy, order.closedAt)} —{" "}
                          <bdi>{order.closeReason}</bdi>
                        </>
                      ),
                    },
                  ]
                : []),
              { label: t("common.note"), value: order.note ?? "—" },
            ]}
          />
        </Card>

        <Card title={t("purchasing.lines")}>
          {order.lines.length === 0 ? (
            <EmptyState title={t("common.none")} />
          ) : (
            <Table label={t("purchasing.lines")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("purchasing.orderedQty")}</Th>
                  <Th>{t("purchasing.unitPrice")}</Th>
                  <Th>{t("purchasing.lineTotal")}</Th>
                  <Th>{t("purchasing.received")}</Th>
                  <Th>{t("purchasing.open")}</Th>
                  {editing ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {order.lines.map((l) => {
                  return (
                    <tr key={l.id}>
                      <Td>
                        {productName(l.product, locale)}
                        <span className="ltr-value text-muted block font-mono text-xs">
                          {l.product.sku}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {fmt(l.quantity)} {l.uom.code}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {money.unitCost(l.unitPrice)}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {money.money(l.lineTotal)}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {fmt(l.receivedQuantityInUnit)} {l.uom.code}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {fmt(l.openQuantityInUnit)} {l.uom.code}
                        </span>
                      </Td>
                      {editing ? (
                        <Td>
                          <details>
                            <summary className="text-primary cursor-pointer text-sm">
                              {t("purchasing.editLine")}
                            </summary>
                            <div className="mt-2 min-w-64">
                              <OrderLineEditForm
                                action={updateOrderLineAction.bind(null, orgSlug, order.id, l.id)}
                                productId={l.productId}
                                uomId={l.uomId}
                                unit={l.uom.code}
                                currency={order.currency}
                                defaults={{
                                  quantity: l.quantity.toString(),
                                  unitPrice: l.unitPrice.toString(),
                                  note: l.note ?? undefined,
                                }}
                              />
                            </div>
                          </details>
                          {l.receivedQuantityBase.isZero() ? (
                            <div className="mt-2">
                              <ConfirmActionButton
                                action={removeOrderLineAction.bind(null, orgSlug, order.id, l.id)}
                                label={t("purchasing.removeLine")}
                                variant="secondary"
                              />
                            </div>
                          ) : null}
                        </Td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {editing ? (
            <div className="mt-4">
              <OrderLineForm
                action={addOrderLineAction.bind(null, orgSlug, order.id)}
                products={productOptions(products, locale)}
                units={unitOptions(units, locale)}
                currency={order.currency}
              />
            </div>
          ) : null}
        </Card>

        <div className="space-y-6 print:hidden">
          {order.underRevision ? (
            <Alert tone="info">{t("purchasing.underRevision", { revision: order.revision })}</Alert>
          ) : null}
          {order.can.revise ? (
            <Card title={t("purchasing.reviseTitle")}>
              <p className="text-muted mb-3 text-sm">{t("purchasing.reviseHint")}</p>
              <div className="max-w-md">
                <ReasonForm
                  action={reviseOrderAction.bind(null, orgSlug, order.id)}
                  label={t("purchasing.reviseReason")}
                  submitLabel={t("purchasing.revise")}
                />
              </div>
            </Card>
          ) : null}
          {order.revisions.length > 0 ? (
            <Card title={t("purchasing.revisionsTitle")}>
              <ol className="divide-border divide-y text-sm">
                {order.revisions.map((r) => (
                  <li key={r.revision} className="py-3">
                    <p className="font-medium">
                      {t("purchasing.revisionFromTo", {
                        from: r.revision,
                        to: r.revision + 1,
                      })}{" "}
                      <span className="text-muted text-xs font-normal">
                        · {who(r.startedBy, r.startedAt)}
                      </span>
                    </p>
                    <p className="text-muted text-xs">
                      <bdi>{r.reason}</bdi>
                    </p>
                    <ul className="mt-1 list-disc ps-5 text-xs">
                      {r.changes.length === 0 &&
                      r.expectedOn.from === r.expectedOn.to &&
                      r.totalAmount.equals(r.nextTotal) ? (
                        <li>{t("purchasing.noChanges")}</li>
                      ) : null}
                      {r.changes.map((c) => {
                        const p = productsById.get(c.productId);
                        const label = p ? `${p.sku} — ${productName(p, locale)}` : c.productId;
                        return (
                          <li key={`${c.kind}-${c.productId}`}>
                            {c.kind === "ADDED"
                              ? t("purchasing.changeAdded", {
                                  product: label,
                                  quantity: fmt(c.quantity),
                                  price: money.unitCost(c.unitPrice),
                                })
                              : c.kind === "REMOVED"
                                ? t("purchasing.changeRemoved", { product: label })
                                : [
                                    c.quantity
                                      ? t("purchasing.changeQuantity", {
                                          product: label,
                                          from: fmt(c.quantity.from),
                                          to: fmt(c.quantity.to),
                                        })
                                      : null,
                                    c.unitPrice
                                      ? t("purchasing.changePrice", {
                                          product: label,
                                          from: money.unitCost(c.unitPrice.from),
                                          to: money.unitCost(c.unitPrice.to),
                                        })
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                          </li>
                        );
                      })}
                      {r.expectedOn.from !== r.expectedOn.to ? (
                        <li>
                          {t("purchasing.changeExpected", {
                            from: r.expectedOn.from ?? "—",
                            to: r.expectedOn.to ?? "—",
                          })}
                        </li>
                      ) : null}
                      {!r.totalAmount.equals(r.nextTotal) ? (
                        <li>
                          {t("purchasing.changeTotal", {
                            from: money.money(r.totalAmount),
                            to: money.money(r.nextTotal),
                          })}
                        </li>
                      ) : null}
                    </ul>
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}
          {order.can.submit ? (
            <Card>
              <p className="text-muted mb-3 text-sm">{t("purchasing.submitHint")}</p>
              <ConfirmActionButton
                action={submitOrderAction.bind(null, orgSlug, order.id)}
                label={t("purchasing.submit")}
                confirmMessage={t("purchasing.confirmSubmit")}
                variant="primary"
              />
            </Card>
          ) : null}

          <ApprovalSteps steps={order.approvalSteps} formatTime={(d) => dt(d)} />

          {order.can.approve || order.can.reject ? (
            <Card>
              <div className="flex flex-wrap items-start gap-6">
                {order.can.approve ? (
                  <ConfirmActionButton
                    action={approveOrderAction.bind(null, orgSlug, order.id)}
                    label={
                      order.approvalSteps.filter((s) => !s.signedAt).length > 1
                        ? t("approvals.signStep")
                        : t("purchasing.approve")
                    }
                    confirmMessage={t("purchasing.confirmApprove")}
                    variant="primary"
                  />
                ) : null}
                <div className="min-w-64 flex-1">
                  <ReasonForm
                    action={rejectOrderAction.bind(null, orgSlug, order.id)}
                    submitLabel={t("purchasing.reject")}
                    label={t("purchasing.rejectReason")}
                  />
                </div>
              </div>
            </Card>
          ) : null}
          {order.approvalBlocked ? (
            <Alert tone="info">{t(`approvals.blocked.${order.approvalBlocked}`)}</Alert>
          ) : null}

          <Card title={t("purchasing.receiptsTitle")}>
            {order.receipts.length === 0 ? (
              <p className="text-muted text-sm">{t("purchasing.noReceipts")}</p>
            ) : (
              <ul className="divide-border divide-y">
                {order.receipts.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <Link
                      href={`/o/${orgSlug}/purchasing/receipts/${r.id}`}
                      className="ltr-value text-primary font-mono hover:underline"
                    >
                      {r.number}
                    </Link>
                    <ReceiptStatusBadge status={r.status} />
                    <span className="text-muted">{dt(r.receivedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {editing ? (
            <Card title={t("purchasing.editHeader")}>
              <OrderHeaderForm
                action={updateOrderHeaderAction.bind(null, orgSlug, order.id)}
                suppliers={suppliers
                  .filter((s) => !order.underRevision || s.id === order.supplierId)
                  .map((s) => ({
                    value: s.id,
                    label: `${s.code} — ${(locale === "ar" && s.nameAr) || s.name}`,
                  }))}
                warehouses={warehouses
                  .filter((w) => !order.underRevision || w.id === order.warehouseId)
                  .map((w) => ({
                    value: w.id,
                    label: `${w.code} — ${w.name}`,
                  }))}
                currencies={order.underRevision ? [order.currency] : currencyChoices(bookCurrency)}
                submitLabel={t("common.save")}
                defaults={{
                  currency: order.currency,
                  supplierId: order.supplierId,
                  warehouseId: order.warehouseId,
                  expectedOn: order.expectedOn?.toISOString().slice(0, 10),
                  note: order.note ?? undefined,
                }}
              />
            </Card>
          ) : null}

          {order.can.close ? (
            <Card title={t("purchasing.close")}>
              <p className="text-muted mb-3 text-sm">{t("purchasing.closeHint")}</p>
              <ReasonForm
                action={closeOrderAction.bind(null, orgSlug, order.id)}
                submitLabel={t("purchasing.close")}
                label={t("purchasing.closeReason")}
              />
            </Card>
          ) : null}
          {order.can.cancel ? (
            <Card title={t("purchasing.cancelOrder")}>
              <p className="text-muted mb-3 text-sm">{t("purchasing.cancelHint")}</p>
              <ReasonForm
                action={cancelOrderAction.bind(null, orgSlug, order.id)}
                submitLabel={t("purchasing.cancelOrder")}
                label={t("purchasing.closeReason")}
                variant="danger"
              />
            </Card>
          ) : null}
        </div>
        <AttachmentsCard
          ctx={ctx}
          orgSlug={orgSlug}
          entityType="PURCHASE_ORDER"
          entityId={order.id}
        />
      </div>
    </>
  );
}
