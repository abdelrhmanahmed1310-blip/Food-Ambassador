import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { OrderStatusBadge, RequisitionStatusBadge } from "@/components/procurement/badges";
import {
  OrderRequisitionForm,
  ReasonForm,
  RequisitionLineForm,
} from "@/components/procurement/forms";
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
import { listProductOptions, listUnits } from "@/modules/catalog/service";
import { getRequisition } from "@/modules/procurement/requisitions";
import { supplierOptions } from "@/modules/procurement/suppliers";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  productName,
  productOptions,
  quantityFormatter,
  unitOptions,
} from "@/server/inventory-view";
import {
  addRequisitionLineAction,
  cancelRequisitionAction,
  closeRequisitionAction,
  orderRequisitionAction,
  rejectRequisitionAction,
  removeRequisitionLineAction,
  submitRequisitionAction,
} from "../../actions";

export default async function RequisitionPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/requisitions/[requisitionId]">) {
  const { orgSlug, requisitionId } = await params;
  if (!isUuid(requisitionId)) notFound();
  const sp = await searchParams;
  const supplierId =
    typeof sp.supplierId === "string" && isUuid(sp.supplierId) ? sp.supplierId : undefined;
  const ctx = await requireTenant(orgSlug);
  const req = await notFoundOnAppError(getRequisition(ctx, requisitionId, { supplierId }));
  const [t, locale, format, fmt] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
  ]);
  const [products, units] = req.can.edit
    ? await Promise.all([listProductOptions(ctx), listUnits(ctx)])
    : [[], []];
  const suppliers = req.can.order ? await supplierOptions(ctx) : [];
  const supplier = suppliers.find((s) => s.id === supplierId);
  const openLines = req.lines.filter((l) => !l.purchaseOrderLineId);
  const dt = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const who = (name: string | null, at: Date | null) => (
    <>
      <bdi>{name ?? "—"}</bdi> · <bdi>{dt(at)}</bdi>
    </>
  );
  const base = `/o/${orgSlug}/purchasing/requisitions/${req.id}`;
  return (
    <>
      <PageHeader
        title={req.number}
        description={`${req.warehouse.code} — ${req.warehouse.name}`}
        actions={<RequisitionStatusBadge status={req.status} />}
      />
      <div className="space-y-6">
        {req.decisionReason ? (
          <Alert tone={req.status === "REJECTED" ? "error" : "info"}>
            {t(`requisitions.decision.${req.status as "REJECTED" | "CLOSED" | "CANCELLED"}`, {
              reason: req.decisionReason,
            })}
          </Alert>
        ) : null}
        <Card>
          <DescriptionList
            items={[
              {
                label: t("requisitions.warehouse"),
                value: `${req.warehouse.code} — ${req.warehouse.name}`,
              },
              {
                label: t("requisitions.neededBy"),
                value: req.neededBy?.toISOString().slice(0, 10) ?? "—",
              },
              { label: t("purchasing.createdBy"), value: who(req.names.createdBy, req.createdAt) },
              ...(req.submittedAt
                ? [
                    {
                      label: t("purchasing.submittedBy"),
                      value: who(req.names.submittedBy, req.submittedAt),
                    },
                  ]
                : []),
              ...(req.decidedAt
                ? [
                    {
                      label: t("requisitions.decidedBy"),
                      value: who(req.names.decidedBy, req.decidedAt),
                    },
                  ]
                : []),
              { label: t("common.note"), value: req.note ?? "—" },
            ]}
          />
        </Card>

        <Card title={t("requisitions.lines")}>
          {req.lines.length === 0 ? (
            <EmptyState title={t("common.none")} />
          ) : (
            <Table label={t("requisitions.lines")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("common.quantity")}</Th>
                  <Th>{t("common.note")}</Th>
                  <Th>{t("requisitions.order")}</Th>
                  {req.can.edit ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {req.lines.map((l) => (
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
                    <Td>{l.note ?? "—"}</Td>
                    <Td>
                      {l.purchaseOrderLine ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/o/${orgSlug}/purchasing/orders/${l.purchaseOrderLine.purchaseOrder.id}`}
                            className="ltr-value text-primary font-mono text-xs hover:underline"
                          >
                            {l.purchaseOrderLine.purchaseOrder.number}
                          </Link>
                          <OrderStatusBadge status={l.purchaseOrderLine.purchaseOrder.status} />
                        </span>
                      ) : (
                        t("requisitions.notOrdered")
                      )}
                    </Td>
                    {req.can.edit ? (
                      <Td>
                        <ConfirmActionButton
                          action={removeRequisitionLineAction.bind(null, orgSlug, req.id, l.id)}
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
          {req.can.edit ? (
            <div className="mt-4">
              <RequisitionLineForm
                action={addRequisitionLineAction.bind(null, orgSlug, req.id)}
                products={productOptions(products, locale)}
                units={unitOptions(units, locale)}
              />
            </div>
          ) : null}
        </Card>

        {req.can.edit ? (
          <Card>
            <p className="text-muted mb-3 text-sm">{t("requisitions.submitHint")}</p>
            <ConfirmActionButton
              action={submitRequisitionAction.bind(null, orgSlug, req.id)}
              label={t("requisitions.submit")}
              confirmMessage={t("requisitions.confirmSubmit")}
              variant="primary"
            />
          </Card>
        ) : null}

        {req.can.order && openLines.length > 0 ? (
          <Card title={t("requisitions.orderTitle")}>
            <p className="text-muted mb-3 text-sm">{t("requisitions.orderHint")}</p>
            <form method="get" action={base} className="mb-4 flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t("purchasing.supplier")}</span>
                <select
                  name="supplierId"
                  defaultValue={supplierId ?? ""}
                  className="border-border bg-surface rounded-md border px-3 py-2"
                  aria-label={t("purchasing.supplier")}
                >
                  <option value="">{t("common.select")}</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} — {(locale === "ar" && s.nameAr) || s.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
              >
                {t("requisitions.chooseSupplier")}
              </button>
            </form>
            {supplier ? (
              <OrderRequisitionForm
                key={supplier.id}
                action={orderRequisitionAction.bind(null, orgSlug, req.id)}
                supplierId={supplier.id}
                currency={ctx.baseCurrency}
                lines={openLines.map((l) => ({
                  id: l.id,
                  label: `${l.product.sku} — ${productName(l.product, locale)}`,
                  quantity: fmt(l.quantity),
                  unit: l.uom.code,
                  suggestedPrice: l.suggestedPrice,
                }))}
              />
            ) : null}
          </Card>
        ) : null}

        {req.can.reject ? (
          <Card title={t("requisitions.reject")}>
            <ReasonForm
              action={rejectRequisitionAction.bind(null, orgSlug, req.id)}
              submitLabel={t("requisitions.reject")}
              label={t("requisitions.reason")}
              variant="danger"
            />
          </Card>
        ) : null}
        {req.can.close ? (
          <Card title={t("requisitions.close")}>
            <p className="text-muted mb-3 text-sm">{t("requisitions.closeHint")}</p>
            <ReasonForm
              action={closeRequisitionAction.bind(null, orgSlug, req.id)}
              submitLabel={t("requisitions.close")}
              label={t("requisitions.reason")}
            />
          </Card>
        ) : null}
        {req.can.cancel ? (
          <Card title={t("requisitions.cancel")}>
            <ReasonForm
              action={cancelRequisitionAction.bind(null, orgSlug, req.id)}
              submitLabel={t("requisitions.cancel")}
              label={t("requisitions.reason")}
              variant="danger"
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
