import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ShipmentStatusBadge } from "@/components/inventory/shipment-badge";
import { ReceiveShipmentForm, ShipmentLineForm } from "@/components/inventory/shipment-forms";
import { ReasonForm } from "@/components/procurement/forms";
import {
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { toDecimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { listUnits } from "@/modules/catalog/service";
import { warehouseOptions } from "@/modules/inventory/queries";
import { getShipment, shipmentSource, shipmentStockOptions } from "@/modules/inventory/shipments";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName, quantityFormatter, unitOptions } from "@/server/inventory-view";
import {
  addShipmentLineAction,
  cancelShipmentAction,
  dispatchShipmentAction,
  receiveShipmentAction,
  removeShipmentLineAction,
} from "../../actions";

export default async function ShipmentPage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/shipments/[shipmentId]">) {
  const { orgSlug, shipmentId } = await params;
  if (!isUuid(shipmentId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const shipment = await notFoundOnAppError(getShipment(ctx, shipmentId));
  const [t, locale, format, fmt] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
  ]);
  const [stock, units] = shipment.can.edit
    ? await Promise.all([
        shipmentSource(ctx, shipment.id).then((w) => shipmentStockOptions(ctx, w)),
        listUnits(ctx),
      ])
    : [[], []];
  const destinationLocations = shipment.can.receive
    ? ((await warehouseOptions(ctx, "inventory.transfer")).find((w) => w.id === shipment.to.id)
        ?.locations ?? [])
    : [];
  const dt = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const docLink = (doc: { id: string; number: string } | null) =>
    doc ? (
      <Link
        href={`/o/${orgSlug}/inventory/documents/${doc.id}`}
        className="ltr-value text-primary font-mono hover:underline"
      >
        {doc.number}
      </Link>
    ) : (
      "—"
    );
  const received = shipment.status === "RECEIVED";
  return (
    <>
      <PageHeader
        title={shipment.number}
        description={`${shipment.from.code} → ${shipment.to.code}`}
        actions={<ShipmentStatusBadge status={shipment.status} />}
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("shipments.from"),
                value: `${shipment.from.code} — ${shipment.from.name}`,
              },
              {
                label: t("shipments.to"),
                value: `${shipment.to.code} — ${shipment.to.name}${
                  shipment.toLocation ? ` / ${shipment.toLocation.code}` : ""
                }`,
              },
              {
                label: t("shipments.expectedOn"),
                value: shipment.expectedOn?.toISOString().slice(0, 10) ?? "—",
              },
              { label: t("shipments.dispatchedAt"), value: dt(shipment.dispatchedAt) },
              { label: t("shipments.receivedAt"), value: dt(shipment.receivedAt) },
              ...(shipment.cancelledAt
                ? [{ label: t("shipments.cancelledAt"), value: dt(shipment.cancelledAt) }]
                : []),
              {
                label: t("shipments.documents"),
                value: (
                  <span className="flex flex-wrap gap-3">
                    {docLink(shipment.dispatchDoc)}
                    {shipment.receiptDoc ? docLink(shipment.receiptDoc) : null}
                    {shipment.cancelDoc ? docLink(shipment.cancelDoc) : null}
                  </span>
                ),
              },
              { label: t("common.note"), value: shipment.note ?? "—" },
            ]}
          />
        </Card>

        <Card title={t("shipments.lines")}>
          {shipment.lines.length === 0 ? (
            <EmptyState title={t("common.none")} />
          ) : (
            <Table label={t("shipments.lines")}>
              <thead>
                <tr>
                  <Th>{t("inventory.product")}</Th>
                  <Th>{t("inventory.lot")}</Th>
                  <Th>{t("common.location")}</Th>
                  <Th>{t("common.quantity")}</Th>
                  {received ? <Th>{t("shipments.received")}</Th> : null}
                  {received ? <Th>{t("shipments.shortageReason")}</Th> : null}
                  {shipment.can.edit ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {shipment.lines.map((l) => (
                  <tr key={l.id}>
                    <Td>
                      {productName(l.product, locale)}
                      <span className="ltr-value text-muted block font-mono text-xs">
                        {l.product.sku}
                      </span>
                    </Td>
                    <Td>
                      <span className="ltr-value font-mono text-xs">{l.lot?.lotCode ?? "—"}</span>
                    </Td>
                    <Td>
                      <span className="ltr-value font-mono text-xs">
                        {l.fromLocation?.code ?? "—"}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {fmt(l.quantity)} {l.uom.code}
                      </span>
                    </Td>
                    {received ? (
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {l.receivedQuantity === null
                            ? "—"
                            : `${fmt(l.receivedQuantity)} ${l.uom.code}`}
                        </span>
                      </Td>
                    ) : null}
                    {received ? (
                      <Td>{l.shortageReason ? t(`inventory.reasons.${l.shortageReason}`) : "—"}</Td>
                    ) : null}
                    {shipment.can.edit ? (
                      <Td>
                        <ConfirmActionButton
                          action={removeShipmentLineAction.bind(null, orgSlug, shipment.id, l.id)}
                          label={t("shipments.removeLine")}
                          variant="secondary"
                        />
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {shipment.can.edit ? (
            <div className="mt-4">
              {stock.length === 0 ? (
                <p className="text-muted text-sm">{t("shipments.noStock")}</p>
              ) : (
                <ShipmentLineForm
                  action={addShipmentLineAction.bind(null, orgSlug, shipment.id)}
                  stock={stock.map((b) => ({
                    value: b.id,
                    label: [
                      `${b.product.sku} — ${productName(b.product, locale)}`,
                      b.lot ? b.lot.lotCode : null,
                      b.location ? b.location.code : null,
                      `${fmt(b.onHandQuantity)} ${b.product.baseUom.code}`,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  }))}
                  units={unitOptions(units, locale)}
                />
              )}
            </div>
          ) : null}
        </Card>

        {shipment.can.dispatch ? (
          <Card>
            <p className="text-muted mb-3 text-sm">{t("shipments.dispatchHint")}</p>
            <ConfirmActionButton
              action={dispatchShipmentAction.bind(null, orgSlug, shipment.id)}
              label={t("shipments.dispatch")}
              confirmMessage={t("shipments.confirmDispatch")}
              variant="primary"
            />
          </Card>
        ) : null}

        {shipment.can.receive ? (
          <Card title={t("shipments.receive")}>
            <p className="text-muted mb-3 text-sm">{t("shipments.receiveHint")}</p>
            <ReceiveShipmentForm
              action={receiveShipmentAction.bind(null, orgSlug, shipment.id)}
              lines={shipment.lines.map((l) => ({
                id: l.id,
                label: `${l.product.sku} — ${productName(l.product, locale)}${
                  l.lot ? ` · ${l.lot.lotCode}` : ""
                }`,
                unit: l.uom.code,
                quantity: toDecimal(l.quantity.toString()).toFixed(),
                quantityLabel: fmt(l.quantity),
              }))}
              locations={destinationLocations.map((loc) => ({
                value: loc.id,
                label: `${loc.code} — ${loc.name}`,
              }))}
            />
          </Card>
        ) : null}

        {shipment.can.cancel ? (
          <Card title={t("shipments.cancel")}>
            <p className="text-muted mb-3 text-sm">{t("shipments.cancelHint")}</p>
            <ReasonForm
              action={cancelShipmentAction.bind(null, orgSlug, shipment.id)}
              submitLabel={t("shipments.cancel")}
              label={t("shipments.cancelReason")}
              variant="danger"
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
