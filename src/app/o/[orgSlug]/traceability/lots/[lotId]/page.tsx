import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import {
  Alert,
  Badge,
  Card,
  DescriptionList,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { traceLot } from "@/modules/traceability/trace";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName, quantityFormatter } from "@/server/inventory-view";

export default async function LotTracePage({
  params,
}: PageProps<"/o/[orgSlug]/traceability/lots/[lotId]">) {
  const { orgSlug, lotId } = await params;
  if (!isUuid(lotId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const trace = await notFoundOnAppError(traceLot(ctx, lotId));
  const [t, locale, format, fmt] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
  ]);
  const { lot } = trace;
  const unit = lot.product.baseUom.code;
  const q = (v: { toString(): string }) => `${fmt(v)} ${unit}`;
  const dt = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone });
  const doc = (d: { id: string; number: string }) => (
    <Link
      href={`/o/${orgSlug}/inventory/documents/${d.id}`}
      className="ltr-value text-primary font-mono text-xs hover:underline"
    >
      {d.number}
    </Link>
  );
  return (
    <>
      <PageHeader
        title={`${t("inventory.lot")} ${lot.lotCode}`}
        description={`${lot.product.sku} — ${productName(lot.product, locale)}`}
        actions={
          <>
            {lot.recallHold ? <Badge tone="danger">{t("trace.recallHold")}</Badge> : null}
            {hasPermission(ctx.grants, "recalls.manage") ? (
              <LinkButton href={`/o/${orgSlug}/recalls/new?lotId=${lot.id}`} variant="secondary">
                {t("trace.startRecall")}
              </LinkButton>
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("inventory.expires"),
                value: lot.expiresOn?.toISOString().slice(0, 10) ?? "—",
              },
              {
                label: t("trace.received"),
                value: <span className="ltr-value tabular-nums">{q(trace.received)}</span>,
              },
              {
                label: t("trace.leftBusiness"),
                value: <span className="ltr-value tabular-nums">{q(trace.exited)}</span>,
              },
              {
                label: t("trace.onHand"),
                value: (
                  <span className="ltr-value tabular-nums" data-testid="lot-on-hand">
                    {q(trace.onHand)}
                  </span>
                ),
              },
            ]}
          />
        </Card>

        {trace.gaps.length > 0 ? (
          <Alert tone="error">
            <p className="font-medium">{t("trace.gapsTitle")}</p>
            <ul className="mt-1 list-disc ps-5">
              {trace.gaps.map((g) => (
                <li key={`${g.kind}-${g.entryId}`}>
                  {t(`trace.gaps.${g.kind}`, {
                    quantity: q(g.quantity),
                    warehouse: g.entry.warehouse.code,
                  })}{" "}
                  {doc(g.entry.document)}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <Alert tone="info">{t("trace.consumptionNote")}</Alert>

        <Card title={t("trace.backward")}>
          {trace.receipts.length === 0 ? (
            <p className="text-muted text-sm">{t("trace.noReceipts")}</p>
          ) : (
            <Table label={t("trace.backward")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.supplier")}</Th>
                  <Th>{t("purchasing.receiptTitle")}</Th>
                  <Th>{t("purchasing.ordersTitle")}</Th>
                  <Th>{t("purchasing.deliveryNote")}</Th>
                  <Th>{t("purchasing.accepted")}</Th>
                  <Th>{t("purchasing.temperature")}</Th>
                </tr>
              </thead>
              <tbody>
                {trace.receipts.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/suppliers/${r.receipt.supplier.id}`}
                        className="text-primary hover:underline"
                      >
                        {r.receipt.supplier.code} —{" "}
                        {(locale === "ar" && r.receipt.supplier.nameAr) || r.receipt.supplier.name}
                      </Link>
                      {r.receipt.supplier.phone ? (
                        <span className="ltr-value text-muted block text-xs">
                          {r.receipt.supplier.phone}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/purchasing/receipts/${r.receipt.id}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {r.receipt.number}
                      </Link>
                      <span className="text-muted block text-xs">{dt(r.receipt.receivedAt)}</span>
                    </Td>
                    <Td>
                      <span className="ltr-value font-mono text-xs">
                        {r.receipt.purchaseOrder.number}
                      </span>
                    </Td>
                    <Td>
                      <span className="ltr-value">{r.receipt.deliveryNoteRef ?? "—"}</span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {fmt(r.acceptedQuantity)} {r.uom.code}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value">
                        {r.temperatureCelsius ? `${r.temperatureCelsius.toFixed()} °C` : "—"}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title={t("trace.forward")}>
          <h3 className="mb-2 text-sm font-medium">{t("trace.stockNow")}</h3>
          {trace.stock.length === 0 ? (
            <p className="text-muted mb-4 text-sm">{t("trace.noStock")}</p>
          ) : (
            <ul className="mb-4 space-y-1 text-sm">
              {trace.stock.map((s) => (
                <li key={`${s.warehouseId}-${s.locationId}-${s.stockStatus}`}>
                  <span className="ltr-value font-mono text-xs">
                    {s.warehouse.code}
                    {s.location ? ` / ${s.location.code}` : ""}
                  </span>{" "}
                  · {t(`inventory.statuses.${s.stockStatus}`)} ·{" "}
                  <span className="ltr-value tabular-nums">{q(s.onHandQuantity)}</span>
                </li>
              ))}
            </ul>
          )}
          {trace.shipments.length > 0 ? (
            <>
              <h3 className="mb-2 text-sm font-medium">{t("nav.shipments")}</h3>
              <ul className="mb-4 space-y-1 text-sm">
                {trace.shipments.map((s) => (
                  <li key={s.shipment.id}>
                    <Link
                      href={`/o/${orgSlug}/inventory/shipments/${s.shipment.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {s.shipment.number}
                    </Link>{" "}
                    <span className="ltr-value font-mono text-xs">
                      {s.shipment.from.code} → {s.shipment.to.code}
                    </span>{" "}
                    · {t(`shipments.statuses.${s.shipment.status}`)} ·{" "}
                    <span className="ltr-value tabular-nums">{q(s.quantityBase)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h3 className="mb-2 text-sm font-medium">{t("trace.movements")}</h3>
          <Table label={t("trace.movements")}>
            <thead>
              <tr>
                <Th>{t("common.date")}</Th>
                <Th>{t("inventory.document")}</Th>
                <Th>{t("inventory.movementType")}</Th>
                <Th>{t("common.warehouse")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>{t("common.quantity")}</Th>
              </tr>
            </thead>
            <tbody>
              {trace.entries.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap">{dt(e.occurredAt)}</Td>
                  <Td>{doc(e.document)}</Td>
                  <Td>{t(`inventory.movementTypes.${e.movementType}`)}</Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{e.warehouse.code}</span>
                  </Td>
                  <Td>{t(`inventory.statuses.${e.stockStatus}`)}</Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value whitespace-nowrap">
                      {e.quantityDelta.gt(0) ? "+" : ""}
                      {q(e.quantityDelta)}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        {trace.recalls.length > 0 ? (
          <Card title={t("recalls.title")}>
            <ul className="space-y-1 text-sm">
              {trace.recalls.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/o/${orgSlug}/recalls/${r.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {r.number}
                  </Link>{" "}
                  {r.title} · {t(`recalls.statuses.${r.status}`)}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
