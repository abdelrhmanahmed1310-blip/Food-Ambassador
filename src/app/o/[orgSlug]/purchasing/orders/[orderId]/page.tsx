import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { OrderStatusBadge, ReceiptStatusBadge } from "@/components/procurement/badges";
import { OrderHeaderForm, OrderLineForm, ReasonForm } from "@/components/procurement/forms";
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
import { isUuid } from "@/lib/uuid";
import { listProductOptions, listUnits } from "@/modules/catalog/service";
import { getOrder, purchasingWarehouseOptions } from "@/modules/procurement/orders";
import { supplierOptions } from "@/modules/procurement/suppliers";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
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
    moneyFormatter(ctx.baseCurrency),
  ]);
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
  return (
    <>
      <PageHeader
        title={order.number}
        description={supplierName}
        actions={
          <>
            <OrderStatusBadge status={order.status} />
            {order.status !== "DRAFT" ? <PrintButton label={t("purchasing.print")} /> : null}
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
                          <ConfirmActionButton
                            action={removeOrderLineAction.bind(null, orgSlug, order.id, l.id)}
                            label={t("purchasing.removeLine")}
                            variant="secondary"
                          />
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
                currency={ctx.baseCurrency}
              />
            </div>
          ) : null}
        </Card>

        <div className="space-y-6 print:hidden">
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

          {order.can.approve ? (
            <Card>
              <div className="flex flex-wrap items-start gap-6">
                <ConfirmActionButton
                  action={approveOrderAction.bind(null, orgSlug, order.id)}
                  label={t("purchasing.approve")}
                  confirmMessage={t("purchasing.confirmApprove")}
                  variant="primary"
                />
                <div className="min-w-64 flex-1">
                  <ReasonForm
                    action={rejectOrderAction.bind(null, orgSlug, order.id)}
                    submitLabel={t("purchasing.reject")}
                    label={t("purchasing.rejectReason")}
                  />
                </div>
              </div>
            </Card>
          ) : order.selfApprovalBlocked ? (
            <Alert tone="info">{t("purchasing.selfApproval")}</Alert>
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
                suppliers={suppliers.map((s) => ({
                  value: s.id,
                  label: `${s.code} — ${(locale === "ar" && s.nameAr) || s.name}`,
                }))}
                warehouses={warehouses.map((w) => ({
                  value: w.id,
                  label: `${w.code} — ${w.name}`,
                }))}
                submitLabel={t("common.save")}
                defaults={{
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
      </div>
    </>
  );
}
