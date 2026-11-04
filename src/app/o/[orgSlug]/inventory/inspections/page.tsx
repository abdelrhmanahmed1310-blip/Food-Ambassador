import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { InspectionForm } from "@/components/wms/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { listInspections, listPendingInspections } from "@/modules/wms/inspections";
import { productName, quantityFormatter } from "@/server/inventory-view";
import { inspectAction } from "./actions";

const TONES = { ACCEPTED: "success", PARTIAL: "warning", REJECTED: "danger" } as const;

/** Receiving inspection: quarantined receipt lines waiting, and recent inspections (ADR-101). */
export default async function InspectionsPage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/inspections">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.quarantine.release")) notFound();
  const [t, locale, format, fmt, pending, done] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    listPendingInspections(ctx),
    listInspections(ctx),
  ]);
  const dt = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone });
  return (
    <>
      <PageHeader title={t("inspections.title")} description={t("inspections.hint")} />
      <div className="space-y-6">
        <h2 className="text-lg font-semibold">{t("inspections.waiting")}</h2>
        {pending.length === 0 ? (
          <EmptyState title={t("inspections.nothingWaiting")} />
        ) : (
          pending.map((l) => {
            const unit = l.product.baseUom.code;
            return (
              <Card
                key={l.id}
                title={`${l.product.sku} — ${productName(l.product, locale)}${l.lot ? ` · ${l.lot.lotCode}` : ""}`}
              >
                <p className="text-muted mb-4 text-sm">
                  <Link
                    href={`/o/${orgSlug}/purchasing/receipts/${l.receipt.id}`}
                    className="ltr-value text-primary font-mono hover:underline"
                  >
                    {l.receipt.number}
                  </Link>
                  {` · ${l.receipt.supplier.code} ${l.receipt.supplier.name} · ${l.receipt.warehouse.code} · ${dt(l.receipt.receivedAt)}`}
                  {l.temperatureCelsius !== null
                    ? ` · ${t("inspections.atReceipt", { temperature: l.temperatureCelsius.toString() })}`
                    : ""}
                  {` · ${t(`catalog.zones.${l.product.storageRequirement}`)}`}
                </p>
                <InspectionForm
                  action={inspectAction.bind(null, orgSlug, l.id)}
                  total={l.acceptedQuantityBase.toString()}
                  unit={unit}
                />
              </Card>
            );
          })
        )}

        <h2 className="text-lg font-semibold">{t("inspections.recent")}</h2>
        {done.length === 0 ? (
          <EmptyState title={t("inspections.none")} />
        ) : (
          <Table label={t("inspections.recent")}>
            <thead>
              <tr>
                <Th>{t("inspections.when")}</Th>
                <Th>{t("inspections.product")}</Th>
                <Th>{t("inspections.accepted")}</Th>
                <Th>{t("inspections.rejected")}</Th>
                <Th>{t("inspections.decision")}</Th>
                <Th>{t("inspections.document")}</Th>
              </tr>
            </thead>
            <tbody>
              {done.map((i) => {
                const unit = i.receiptLine.product.baseUom.code;
                return (
                  <tr key={i.id}>
                    <Td>
                      {dt(i.inspectedAt)}
                      <span className="text-muted block text-xs">{i.inspectedBy ?? ""}</span>
                    </Td>
                    <Td>
                      {i.receiptLine.product.sku} — {productName(i.receiptLine.product, locale)}
                      <span className="ltr-value text-muted block font-mono text-xs">
                        {i.receiptLine.receipt.number}
                        {i.receiptLine.lot ? ` · ${i.receiptLine.lot.lotCode}` : ""}
                      </span>
                    </Td>
                    <Td className="ltr-value tabular-nums">{`${fmt(i.acceptedQuantity)} ${unit}`}</Td>
                    <Td className="ltr-value tabular-nums">
                      {`${fmt(i.rejectedQuantity)} ${unit}`}
                      {i.rejectionReason ? (
                        <span className="text-muted block text-xs">{i.rejectionReason}</span>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={TONES[i.decision]}>
                        {t(`inspections.decisions.${i.decision}`)}
                      </Badge>
                    </Td>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/inventory/documents/${i.document.id}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {i.document.number}
                      </Link>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
