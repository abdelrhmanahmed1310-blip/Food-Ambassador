import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { AttachmentsCard } from "@/components/attachments/attachments-card";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { TextReasonForm } from "@/components/invoices/forms";
import {
  AdvanceForm,
  ContainerForm,
  PickOneForm,
  ShipmentForm,
  TradeDocumentForm,
} from "@/components/trade/forms";
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
import { countryOptions } from "@/lib/countries";
import { tradeDocumentOptions } from "@/modules/trade/documents";
import { getShipment } from "@/modules/trade/shipments";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  addContainerAction,
  advanceShipmentAction,
  cancelShipmentAction,
  linkOrderAction,
  linkReceiptAction,
  removeContainerAction,
  unlinkOrderAction,
  updateShipmentAction,
} from "../actions";
import { addShipmentDocumentAction } from "../../documents/actions";

/** One import shipment: transport, orders, containers, receipts and its steps (ADR-113). */
export default async function ImportShipmentPage({
  params,
}: PageProps<"/o/[orgSlug]/trade/shipments/[shipmentId]">) {
  const { orgSlug, shipmentId } = await params;
  const ctx = await requireTenant(orgSlug);
  const s = await notFoundOnAppError(getShipment(ctx, shipmentId));
  const [t, locale, docOptions] = await Promise.all([
    getTranslations(),
    getLocale(),
    tradeDocumentOptions(ctx),
  ]);
  const shipmentTypes = docOptions.types
    .filter((x) => x.scope === "SHIPMENT")
    .map((x) => ({ value: x.id, label: `${x.code} — ${(locale === "ar" && x.nameAr) || x.name}` }));
  const dash = (v: string | null | undefined) => v ?? "—";
  const ltr = (v: string | null | undefined) => <span className="ltr-value">{dash(v)}</span>;
  return (
    <>
      <PageHeader
        title={`${s.number} — ${s.supplier.name}`}
        description={t("trade.detailHint")}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={s.status === "CANCELLED" || s.status === "CLOSED" ? "muted" : "neutral"}>
              {t(`trade.statuses.${s.status}`)}
            </Badge>
            {s.daysLate ? (
              <Badge tone="danger">{t("trade.daysLate", { days: s.daysLate })}</Badge>
            ) : null}
          </span>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("trade.supplier"), value: `${s.supplier.code} — ${s.supplier.name}` },
              { label: t("trade.warehouse"), value: `${s.warehouse.code} — ${s.warehouse.name}` },
              { label: t("trade.company"), value: `${s.company.code} — ${s.company.name}` },
              { label: t("trade.mode"), value: t(`trade.modes.${s.mode}`) },
              { label: t("trade.incoterm"), value: dash(s.incoterm) },
              { label: t("trade.originCountry"), value: dash(s.originCountry) },
              {
                label: t("trade.route"),
                value: `${dash(s.portOfLoading)} → ${dash(s.portOfDischarge)}`,
              },
              { label: t("trade.carrier"), value: dash(s.carrier) },
              { label: t("trade.transportDocument"), value: ltr(s.transportDocument) },
              { label: t("trade.vesselOrFlight"), value: dash(s.vesselOrFlight) },
              { label: t("trade.etd"), value: ltr(s.etd) },
              { label: t("trade.eta"), value: ltr(s.eta) },
              { label: t("trade.departedOn"), value: ltr(s.departedOn) },
              { label: t("trade.arrivedOn"), value: ltr(s.arrivedOn) },
              { label: t("trade.clearedOn"), value: ltr(s.clearedOn) },
              ...(s.cancelReason
                ? [{ label: t("trade.cancelReason"), value: s.cancelReason }]
                : []),
            ]}
          />
        </Card>

        {s.canManage && s.next ? (
          <Card title={t(`trade.steps.${s.next}`)}>
            <AdvanceForm
              action={advanceShipmentAction.bind(null, orgSlug, s.id)}
              submitLabel={t(`trade.steps.${s.next}`)}
              withDate={s.next !== "CLOSED"}
            />
          </Card>
        ) : null}

        <Card title={t("trade.orders")}>
          {s.orders.length === 0 ? (
            <EmptyState title={t("trade.noOrders")} />
          ) : (
            <Table label={t("trade.orders")}>
              <thead>
                <tr>
                  <Th>{t("trade.order")}</Th>
                  <Th>{t("trade.orderStatus")}</Th>
                  <Th>{t("trade.received")}</Th>
                  {s.canEdit ? <Th>{""}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {s.orders.map((o) => (
                  <tr key={o.id}>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/purchasing/orders/${o.id}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {o.number}
                      </Link>
                    </Td>
                    <Td>{t(`purchasing.statuses.${o.status}`)}</Td>
                    <Td>
                      <span className="ltr-value">
                        {o.receivedShare === null
                          ? "—"
                          : `${o.receivedShare.times(100).toFixed(0)}%`}
                      </span>
                    </Td>
                    {s.canEdit ? (
                      <Td>
                        <ConfirmActionButton
                          action={unlinkOrderAction.bind(null, orgSlug, s.id, o.id)}
                          label={t("trade.unlink")}
                          variant="secondary"
                        />
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {s.canEdit && s.openOrders.length > 0 ? (
            <div className="mt-4">
              <PickOneForm
                action={linkOrderAction.bind(null, orgSlug, s.id)}
                name="purchaseOrderId"
                label={t("trade.addOrder")}
                options={s.openOrders.map((o) => ({ value: o.id, label: o.number }))}
                submitLabel={t("trade.link")}
              />
            </div>
          ) : null}
        </Card>

        <Card title={t("trade.containers")}>
          {s.containers.length === 0 ? (
            <EmptyState title={t("trade.noContainers")} />
          ) : (
            <Table label={t("trade.containers")}>
              <thead>
                <tr>
                  <Th>{t("trade.containerNumber")}</Th>
                  <Th>{t("trade.containerType")}</Th>
                  <Th>{t("trade.sealNumber")}</Th>
                  <Th>{t("trade.temperature")}</Th>
                  {s.canEdit ? <Th>{""}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {s.containers.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <span className="ltr-value font-mono">{c.number}</span>
                    </Td>
                    <Td>{t(`trade.containerTypes.${c.type}`)}</Td>
                    <Td>{ltr(c.sealNumber)}</Td>
                    <Td>
                      {c.temperatureC === null ? (
                        "—"
                      ) : (
                        <span className="ltr-value">{`${c.temperatureC.toString()} °C`}</span>
                      )}
                    </Td>
                    {s.canEdit ? (
                      <Td>
                        <ConfirmActionButton
                          action={removeContainerAction.bind(null, orgSlug, s.id, c.id)}
                          label={t("trade.remove")}
                          variant="secondary"
                        />
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {s.canEdit ? (
            <div className="mt-4">
              <ContainerForm action={addContainerAction.bind(null, orgSlug, s.id)} />
            </div>
          ) : null}
        </Card>

        <Card title={t("trade.receipts")}>
          {s.receipts.length === 0 ? (
            <EmptyState title={t("trade.noReceipts")} />
          ) : (
            <ul className="space-y-1 text-sm">
              {s.receipts.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/o/${orgSlug}/purchasing/receipts/${r.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {r.number}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {s.linkableReceipts.length > 0 ? (
            <div className="mt-4">
              <PickOneForm
                action={linkReceiptAction.bind(null, orgSlug, s.id)}
                name="receiptId"
                label={t("trade.addReceipt")}
                options={s.linkableReceipts.map((r) => ({ value: r.id, label: r.number }))}
                submitLabel={t("trade.link")}
              />
            </div>
          ) : null}
        </Card>

        {s.canEdit ? (
          <Card title={t("trade.editTitle")}>
            <ShipmentForm
              action={updateShipmentAction.bind(null, orgSlug, s.id)}
              submitLabel={t("common.save")}
              countries={countryOptions(locale)}
              defaults={{
                mode: s.mode,
                incoterm: s.incoterm ?? "",
                originCountry: s.originCountry ?? "",
                portOfLoading: s.portOfLoading ?? "",
                portOfDischarge: s.portOfDischarge ?? "",
                carrier: s.carrier ?? "",
                transportDocument: s.transportDocument ?? "",
                vesselOrFlight: s.vesselOrFlight ?? "",
                etd: s.etd ?? "",
                eta: s.eta ?? "",
                note: s.note ?? "",
              }}
            />
          </Card>
        ) : null}

        <Card title={t("tradeDocs.checklist")}>
          {!s.checklist.destinationKnown ? (
            <p className="text-muted mb-3 text-sm">{t("tradeDocs.destinationUnknown")}</p>
          ) : null}
          {s.checklist.withoutHsCode.length > 0 ? (
            <p className="text-muted mb-3 text-sm">
              {t("tradeDocs.withoutHsCode", { products: s.checklist.withoutHsCode.join(", ") })}
            </p>
          ) : null}
          {s.checklist.withoutOrigin.length > 0 ? (
            <p className="text-muted mb-3 text-sm">
              {t("tradeDocs.withoutOrigin", { products: s.checklist.withoutOrigin.join(", ") })}
            </p>
          ) : null}
          {s.checklist.lines.length === 0 ? (
            <EmptyState title={t("tradeDocs.nothingRequired")} />
          ) : (
            <Table label={t("tradeDocs.checklist")}>
              <thead>
                <tr>
                  <Th>{t("tradeDocs.type")}</Th>
                  <Th>{t("tradeDocs.heldFor")}</Th>
                  <Th>{t("tradeDocs.authority")}</Th>
                  <Th>{t("tradeDocs.document")}</Th>
                  <Th>{t("tradeDocs.check")}</Th>
                </tr>
              </thead>
              <tbody>
                {s.checklist.lines.map((l) => (
                  <tr
                    key={`${l.documentTypeId}|${l.productId ?? ""}`}
                    data-testid={`check-${l.documentType.code}${l.product ? `-${l.product.sku}` : ""}`}
                  >
                    <Td>
                      {l.documentType.code} —{" "}
                      {(locale === "ar" && l.documentType.nameAr) || l.documentType.name}
                    </Td>
                    <Td>{l.product ? l.product.sku : t("tradeDocs.thisShipment")}</Td>
                    <Td>{l.authority ?? "—"}</Td>
                    <Td>
                      {l.document ? (
                        <Link
                          href={`/o/${orgSlug}/trade/documents/${l.document.id}`}
                          className="ltr-value text-primary hover:underline"
                        >
                          {l.document.number ?? l.document.expiresOn ?? "✓"}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          l.state === "OK"
                            ? "success"
                            : l.state === "EXPIRING"
                              ? "warning"
                              : "danger"
                        }
                      >
                        {t(`tradeDocs.checks.${l.state}`)}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {s.documents.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-medium">{t("tradeDocs.onShipment")}</h3>
              <ul className="space-y-1 text-sm">
                {s.documents.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/o/${orgSlug}/trade/documents/${d.id}`}
                      className="text-primary hover:underline"
                    >
                      {d.documentType.code}{" "}
                      {d.number ? <span className="ltr-value">{d.number}</span> : null}
                    </Link>{" "}
                    {d.expiresOn ? (
                      <span className="ltr-value text-muted">{d.expiresOn}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {s.canAddDocuments && shipmentTypes.length > 0 ? (
            <div className="mt-4">
              <TradeDocumentForm
                action={addShipmentDocumentAction.bind(null, orgSlug, s.id)}
                submitLabel={t("tradeDocs.add")}
                types={shipmentTypes}
              />
            </div>
          ) : null}
        </Card>

        <AttachmentsCard ctx={ctx} orgSlug={orgSlug} entityType="IMPORT_SHIPMENT" entityId={s.id} />

        {s.canCancel ? (
          <Card title={t("trade.cancel")}>
            <TextReasonForm
              action={cancelShipmentAction.bind(null, orgSlug, s.id)}
              name="reason"
              label={t("trade.cancelReason")}
              submitLabel={t("trade.cancel")}
              variant="danger"
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
