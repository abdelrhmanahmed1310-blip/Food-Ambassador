import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { TextReasonForm } from "@/components/invoices/forms";
import { PackForm } from "@/components/wms/loading-forms";
import { ConfirmPickForm } from "@/components/wms/picking-forms";
import { Card, DescriptionList, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getPickList } from "@/modules/wms/picking";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName, quantityFormatter } from "@/server/inventory-view";
import { packAction, removePackUnitAction } from "../../loads/actions";
import { cancelPickListAction, confirmPickAction, deliverPickListAction } from "../actions";
import { PickStatusBadge } from "../badge";

export default async function PickListPage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/picking/[pickListId]">) {
  const { orgSlug, pickListId } = await params;
  if (!isUuid(pickListId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const p = await notFoundOnAppError(getPickList(ctx, pickListId));
  const [t, locale, fmt] = await Promise.all([getTranslations(), getLocale(), quantityFormatter()]);
  const doc = (d: { id: string; number: string } | null) =>
    d ? (
      <Link
        href={`/o/${orgSlug}/inventory/documents/${d.id}`}
        className="ltr-value text-primary font-mono text-xs hover:underline"
      >
        {d.number}
      </Link>
    ) : (
      "—"
    );
  const label = (l: (typeof p.walk)[number]) =>
    `${l.location?.code ?? t("picking.noLocation")} · ${l.product.sku} — ${productName(l.product, locale)}${l.lot ? ` · ${l.lot.lotCode}` : ""}`;
  return (
    <>
      <PageHeader
        title={`${p.number} — ${p.salesOrder.number}`}
        description={`${p.salesOrder.customer.code} — ${p.salesOrder.customer.name} · ${p.warehouse.code}`}
        actions={
          <>
            <PickStatusBadge status={p.status} />
            <a
              href={`/o/${orgSlug}/inventory/picking/${p.id}/pdf`}
              className={buttonClass("secondary")}
            >
              {t("picking.sheet")}
            </a>
            {p.packUnits.length > 0 ? (
              <a
                href={`/o/${orgSlug}/inventory/picking/${p.id}/packing-list`}
                className={buttonClass("secondary")}
              >
                {t("loads.packingList")}
              </a>
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("picking.order"),
                value: (
                  <Link
                    href={`/o/${orgSlug}/b2b/orders/${p.salesOrder.id}`}
                    className="ltr-value text-primary font-mono hover:underline"
                  >
                    {p.salesOrder.number}
                  </Link>
                ),
              },
              ...(p.wave
                ? [
                    {
                      label: t("picking.wave"),
                      value: (
                        <Link
                          href={`/o/${orgSlug}/inventory/picking/waves/${p.wave.id}`}
                          className="ltr-value text-primary font-mono hover:underline"
                        >
                          {p.wave.number}
                        </Link>
                      ),
                    },
                  ]
                : []),
              { label: t("picking.pickDocument"), value: doc(p.pickDocument) },
              ...(p.load
                ? [
                    {
                      label: t("loads.load"),
                      value: (
                        <Link
                          href={`/o/${orgSlug}/inventory/loads/${p.load.id}`}
                          className="ltr-value text-primary font-mono hover:underline"
                        >
                          {p.load.number}
                        </Link>
                      ),
                    },
                  ]
                : []),
              ...(p.delivery
                ? [
                    {
                      label: t("picking.delivery"),
                      value: <span className="ltr-value font-mono">{p.delivery.number}</span>,
                    },
                  ]
                : []),
              ...(p.returnDocument
                ? [{ label: t("picking.returnDocument"), value: doc(p.returnDocument) }]
                : []),
              ...(p.cancelReason
                ? [{ label: t("picking.cancelReason"), value: p.cancelReason }]
                : []),
            ]}
          />
        </Card>

        <Table label={t("picking.lines")}>
          <thead>
            <tr>
              <Th>{t("picking.from")}</Th>
              <Th>{t("picking.product")}</Th>
              <Th>{t("picking.lot")}</Th>
              <Th>{t("picking.planned")}</Th>
              <Th>{t("picking.picked")}</Th>
              <Th>{t("picking.to")}</Th>
            </tr>
          </thead>
          <tbody>
            {p.walk.map((l) => {
              const unit = l.product.baseUom.code;
              return (
                <tr key={l.id}>
                  <Td className="ltr-value font-mono text-xs">
                    {l.location?.code ?? t("picking.noLocation")}
                  </Td>
                  <Td>
                    {l.product.sku} — {productName(l.product, locale)}
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{l.lot?.lotCode ?? "—"}</span>
                    {l.lot?.expiresOn ? (
                      <span className="text-muted block text-xs">
                        {l.lot.expiresOn.toISOString().slice(0, 10)}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="ltr-value tabular-nums">{`${fmt(l.plannedQuantity)} ${unit}`}</Td>
                  <Td className="ltr-value tabular-nums">
                    {l.pickedQuantity === null ? "—" : `${fmt(l.pickedQuantity)} ${unit}`}
                    {l.shortReason ? (
                      <span className="text-muted block text-xs">{l.shortReason}</span>
                    ) : null}
                  </Td>
                  <Td className="ltr-value font-mono text-xs">{l.staging.code}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>

        {p.status === "PLANNED" && p.canPick ? (
          <Card title={t("picking.confirmTitle")}>
            <ConfirmPickForm
              action={confirmPickAction.bind(null, orgSlug, p.id)}
              lines={p.walk.map((l) => ({
                id: l.id,
                label: label(l),
                planned: l.plannedQuantity.toString(),
                unit: l.product.baseUom.code,
              }))}
            />
          </Card>
        ) : null}
        {p.status !== "PLANNED" && (p.packUnits.length > 0 || p.status === "PICKED") ? (
          <Card title={t("loads.packing")}>
            {p.packUnits.length === 0 ? (
              <p className="text-muted mb-3 text-sm">{t("loads.notPacked")}</p>
            ) : (
              <ul className="mb-4 space-y-2 text-sm">
                {p.packUnits.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-3">
                    <span className="ltr-value font-mono">{u.number}</span>
                    <span>{t(`loads.unitTypes.${u.type}`)}</span>
                    <span className="text-muted">
                      {u.lines
                        .map((x) => {
                          const line = p.lines.find((l) => l.id === x.pickListLineId);
                          return `${line?.product.sku ?? ""} ${fmt(x.quantity)} ${line?.product.baseUom.code ?? ""}`;
                        })
                        .join(" · ")}
                      {u.grossWeightKg ? ` · ${fmt(u.grossWeightKg)} kg` : ""}
                    </span>
                    {p.status === "PICKED" && !p.load && p.canPick ? (
                      <ConfirmActionButton
                        action={removePackUnitAction.bind(null, orgSlug, u.id)}
                        label={t("loads.unpack")}
                        variant="secondary"
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {p.status === "PICKED" && !p.load && p.canPick && !p.packingComplete ? (
              <PackForm
                action={packAction.bind(null, orgSlug, p.id)}
                lines={p.walk
                  .map((l) => ({
                    id: l.id,
                    label: `${l.product.sku}${l.lot ? ` · ${l.lot.lotCode}` : ""}`,
                    remaining: new Decimal(l.pickedQuantity?.toString() ?? "0")
                      .minus(p.packed.get(l.id) ?? new Decimal(0))
                      .toFixed(),
                    unit: l.product.baseUom.code,
                  }))
                  .filter((l) => new Decimal(l.remaining).gt(0))}
              />
            ) : p.packingComplete && p.status === "PICKED" ? (
              <p className="text-sm">{t("loads.packedComplete")}</p>
            ) : null}
          </Card>
        ) : null}
        {p.status === "PICKED" && p.canDeliver && !p.load ? (
          <Card title={t("picking.deliverTitle")}>
            <p className="text-muted mb-3 text-sm">{t("picking.deliverHint")}</p>
            <ConfirmActionButton
              action={deliverPickListAction.bind(null, orgSlug, p.id)}
              label={t("picking.deliver")}
              variant="primary"
            />
          </Card>
        ) : null}
        {(p.status === "PLANNED" || p.status === "PICKED") && p.canPick && !p.load ? (
          <Card title={t("picking.cancel")}>
            <p className="text-muted mb-3 text-sm">
              {p.status === "PICKED"
                ? t("picking.cancelPickedHint")
                : t("picking.cancelPlannedHint")}
            </p>
            <TextReasonForm
              action={cancelPickListAction.bind(null, orgSlug, p.id)}
              name="reason"
              label={t("picking.cancelReason")}
              submitLabel={t("picking.cancel")}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
