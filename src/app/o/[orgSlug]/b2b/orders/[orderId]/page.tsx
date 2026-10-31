import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { DeliverForm, InvoiceDeliveryForm, SalesOrderLineForm } from "@/components/b2b/forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
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
import { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { getSalesOrder } from "@/modules/b2b/service";
import { listProductOptions, listUnits } from "@/modules/catalog/service";
import { businessDate } from "@/modules/inventory/rules";
import { invoiceFormOptions } from "@/modules/invoices/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  moneyFormatter,
  productName,
  productOptions,
  quantityFormatter,
  unitOptions,
} from "@/server/inventory-view";
import { hasPermission } from "@/modules/access/authorize";
import {
  addSalesOrderLineAction,
  cancelSalesOrderAction,
  confirmSalesOrderAction,
  deliverSalesOrderAction,
  invoiceDeliveryAction,
  removeSalesOrderLineAction,
  reverseDeliveryAction,
} from "../../actions";

export default async function SalesOrderPage({
  params,
}: PageProps<"/o/[orgSlug]/b2b/orders/[orderId]">) {
  const { orgSlug, orderId } = await params;
  if (!isUuid(orderId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const o = await notFoundOnAppError(getSalesOrder(ctx, orderId));
  const [t, locale, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const [products, units, options] = o.can.edit
    ? await Promise.all([
        listProductOptions(ctx),
        listUnits(ctx),
        hasPermission(ctx.grants, "invoices.manage")
          ? invoiceFormOptions(ctx)
          : Promise.resolve({ suppliers: [], taxCodes: [] }),
      ])
    : [[], [], { suppliers: [], taxCodes: [] }];
  const amount = (v: { toString(): string }) => (
    <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>
  );
  const base = `/o/${orgSlug}/b2b`;
  const openLines = o.lines
    .map((l) => ({
      l,
      open: new Decimal(l.quantityBase.toString()).minus(l.deliveredQuantityBase.toString()),
    }))
    .filter((x) => x.open.gt(0));
  return (
    <>
      <PageHeader
        title={o.number}
        description={`${o.customer.code} — ${(locale === "ar" && o.customer.nameAr) || o.customer.name}`}
        actions={
          <Badge
            tone={
              o.status === "DELIVERED" ? "success" : o.status === "CANCELLED" ? "muted" : "warning"
            }
          >
            {t(`b2b.statuses.${o.status}`)}
          </Badge>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("b2b.shipFrom"), value: `${o.warehouse.code} — ${o.warehouse.name}` },
              {
                label: t("b2b.customerRef"),
                value: <span className="ltr-value">{o.customerRef ?? "—"}</span>,
              },
              { label: t("b2b.orderNet"), value: amount(o.net) },
            ]}
          />
        </Card>
        <Card title={t("b2b.lines")}>
          {o.lines.length === 0 ? (
            <EmptyState title={t("invoices.noLines")} />
          ) : (
            <Table label={t("b2b.lines")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("common.quantity")}</Th>
                  <Th>{t("b2b.netPrice")}</Th>
                  <Th>{t("invoices.vatCode")}</Th>
                  <Th>{t("b2b.delivered")}</Th>
                  {o.can.edit ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l) => (
                  <tr key={l.id}>
                    <Td>
                      {l.product.sku} — {productName(l.product, locale)}
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value">
                        {fmt(l.quantity)} {l.uom.code}
                      </span>
                    </Td>
                    <Td className="tabular-nums">{amount(l.unitPrice)}</Td>
                    <Td>{l.taxCode?.code ?? t("b2b.defaultSalesVat")}</Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value">
                        {fmt(l.deliveredQuantityBase)} {l.product.baseUom.code}
                      </span>
                    </Td>
                    {o.can.edit ? (
                      <Td>
                        <ConfirmActionButton
                          action={removeSalesOrderLineAction.bind(null, orgSlug, o.id, l.id)}
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
          {o.can.edit ? (
            <div className="mt-4">
              <SalesOrderLineForm
                action={addSalesOrderLineAction.bind(null, orgSlug, o.id)}
                products={productOptions(products, locale)}
                units={unitOptions(units, locale)}
                taxCodes={options.taxCodes.map((c) => ({ value: c.id, label: c.code }))}
              />
            </div>
          ) : null}
        </Card>
        {o.can.confirm ? (
          <Card>
            <ConfirmActionButton
              action={confirmSalesOrderAction.bind(null, orgSlug, o.id)}
              label={t("b2b.confirm")}
              confirmMessage={t("b2b.confirmQuestion")}
              variant="primary"
            />
          </Card>
        ) : null}
        {o.can.deliver && openLines.length > 0 ? (
          <Card title={t("b2b.deliver")}>
            <p className="text-muted mb-3 text-sm">{t("b2b.deliverHint")}</p>
            <DeliverForm
              action={deliverSalesOrderAction.bind(null, orgSlug, o.id)}
              lines={openLines.map(({ l, open }) => ({
                id: l.id,
                label: `${l.product.sku} (${l.product.baseUom.code})`,
                open: open.toFixed(),
              }))}
            />
          </Card>
        ) : null}
        {o.deliveries.length > 0 ? (
          <Card title={t("b2b.deliveries")}>
            <ul className="space-y-3 text-sm">
              {o.deliveries.map((d) => {
                const invoice = d.invoices.find((i) => i.status === "POSTED");
                return (
                  <li
                    key={d.id}
                    className="border-border rounded-md border p-3"
                    data-testid={`delivery-${d.number}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/o/${orgSlug}/inventory/documents/${d.document.id}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {d.number}
                      </Link>
                      <span>
                        {t("b2b.costOfGoods")}: {amount(d.cost)}
                      </span>
                      {d.status === "REVERSED" ? (
                        <Badge tone="muted">{t("production.statuses.REVERSED")}</Badge>
                      ) : null}
                      {invoice ? (
                        <Link
                          href={`${base}/invoices/${invoice.id}`}
                          className="ltr-value text-primary font-mono text-xs hover:underline"
                        >
                          {invoice.number} · {money.money(invoice.grossAmount)}
                        </Link>
                      ) : null}
                    </div>
                    {o.can.invoice && d.status === "POSTED" && !invoice ? (
                      <div className="mt-2 flex flex-wrap items-end gap-4">
                        <InvoiceDeliveryForm
                          action={invoiceDeliveryAction.bind(null, orgSlug, d.id)}
                          today={businessDate(ctx.timeZone)}
                        />
                        <details>
                          <summary className="text-primary cursor-pointer text-xs">
                            {t("b2b.reverseDelivery")}
                          </summary>
                          <TextReasonForm
                            action={reverseDeliveryAction.bind(null, orgSlug, d.id)}
                            name="reason"
                            label={t("invoices.cancelReason")}
                            submitLabel={t("b2b.reverseDelivery")}
                            variant="danger"
                          />
                        </details>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : null}
        {o.can.cancel ? (
          <Card title={t("b2b.cancelOrder")}>
            <TextReasonForm
              action={cancelSalesOrderAction.bind(null, orgSlug, o.id)}
              name="reason"
              label={t("invoices.cancelReason")}
              submitLabel={t("b2b.cancelOrder")}
              variant="danger"
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
