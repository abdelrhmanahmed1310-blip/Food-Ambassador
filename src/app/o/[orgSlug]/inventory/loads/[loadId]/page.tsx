import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { TextReasonForm } from "@/components/invoices/forms";
import { AddToLoadForm, DispatchForm, LoadedForm } from "@/components/wms/loading-forms";
import {
  Badge,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getLoad } from "@/modules/wms/loading";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName, quantityFormatter } from "@/server/inventory-view";
import {
  addToLoadAction,
  cancelLoadAction,
  confirmLoadedAction,
  dispatchLoadAction,
  removeFromLoadAction,
} from "../actions";

const TONES = { OPEN: "warning", DISPATCHED: "success", CANCELLED: "muted" } as const;

/** One vehicle load: lists and units on it, loading confirmation and dispatch (ADR-103). */
export default async function LoadPage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/loads/[loadId]">) {
  const { orgSlug, loadId } = await params;
  if (!isUuid(loadId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const l = await notFoundOnAppError(getLoad(ctx, loadId));
  const [t, locale, format, fmt] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
  ]);
  const open = l.status === "OPEN";
  const dt = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone });
  return (
    <>
      <PageHeader
        title={`${l.number} — ${l.vehicleRef}`}
        description={`${l.warehouse.code} — ${l.warehouse.name}${l.driverName ? ` · ${l.driverName}` : ""}`}
        actions={
          <>
            <Badge tone={TONES[l.status]}>{t(`loads.statuses.${l.status}`)}</Badge>
            <a
              href={`/o/${orgSlug}/inventory/loads/${l.id}/pdf`}
              className={buttonClass("secondary")}
            >
              {t("loads.manifest")}
            </a>
          </>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("loads.progress"),
                value: t("loads.loadedOf", { loaded: l.loadedCount, total: l.unitCount }),
              },
              ...(l.dispatchedAt
                ? [
                    { label: t("loads.dispatchedAt"), value: dt(l.dispatchedAt) },
                    {
                      label: t("loads.vehicleTemperature"),
                      value: l.vehicleTemperatureCelsius
                        ? `${l.vehicleTemperatureCelsius.toString()} °C`
                        : "—",
                    },
                    {
                      label: t("loads.seal"),
                      value: <span className="ltr-value">{l.sealNumber ?? "—"}</span>,
                    },
                  ]
                : []),
              ...(l.cancelReason
                ? [{ label: t("loads.cancelReason"), value: l.cancelReason }]
                : []),
              ...(l.note ? [{ label: t("common.note"), value: l.note }] : []),
            ]}
          />
        </Card>

        {open && l.canLoad ? (
          <Card title={t("loads.loadingTitle")}>
            <LoadedForm action={confirmLoadedAction.bind(null, orgSlug, l.id)} />
          </Card>
        ) : null}

        {l.pickLists.length === 0 ? null : (
          <Table label={t("loads.units")}>
            <thead>
              <tr>
                <Th>{t("loads.unitNumber")}</Th>
                <Th>{t("loads.orders")}</Th>
                <Th>{t("loads.contents")}</Th>
                <Th>{t("loads.loadedStatus")}</Th>
              </tr>
            </thead>
            <tbody>
              {l.pickLists.flatMap((p) =>
                p.packUnits.map((u) => (
                  <tr key={u.id}>
                    <Td>
                      <span className="ltr-value font-mono text-xs">{u.number}</span>
                      <span className="text-muted block text-xs">
                        {t(`loads.unitTypes.${u.type}`)}
                      </span>
                    </Td>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/inventory/picking/${p.id}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {p.number}
                      </Link>
                      <span className="text-muted block text-xs">
                        {p.salesOrder.number} · {p.salesOrder.customer.name}
                      </span>
                    </Td>
                    <Td className="text-sm">
                      {u.lines
                        .map(
                          (x) =>
                            `${x.pickListLine.product.sku} — ${productName(x.pickListLine.product, locale)}${x.pickListLine.lot ? ` (${x.pickListLine.lot.lotCode})` : ""}: ${fmt(x.quantity)} ${x.pickListLine.product.baseUom.code}`,
                        )
                        .join("; ")}
                    </Td>
                    <Td>
                      {u.loadedAt ? (
                        <Badge tone="success">{t("loads.isLoaded")}</Badge>
                      ) : open && l.canLoad ? (
                        <ConfirmActionButton
                          action={confirmLoadedAction.bind(null, orgSlug, l.id)}
                          label={t("loads.markLoaded")}
                          variant="secondary"
                          hidden={{ unit: u.id }}
                        />
                      ) : (
                        <Badge tone="muted">{t("loads.notLoaded")}</Badge>
                      )}
                    </Td>
                  </tr>
                )),
              )}
            </tbody>
          </Table>
        )}

        {open && l.canLoad ? (
          <Card title={t("loads.listsTitle")}>
            {l.pickLists.length > 0 ? (
              <ul className="mb-4 space-y-2 text-sm">
                {l.pickLists.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3">
                    <span className="ltr-value font-mono">{p.number}</span>
                    <span>
                      {p.salesOrder.number} · {p.salesOrder.customer.name}
                    </span>
                    <ConfirmActionButton
                      action={removeFromLoadAction.bind(null, orgSlug, l.id, p.id)}
                      label={t("loads.takeOff")}
                      variant="secondary"
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted mb-3 text-sm">{t("loads.noLists")}</p>
            )}
            {l.candidates.length === 0 ? (
              <p className="text-muted text-sm">{t("loads.noCandidates")}</p>
            ) : (
              <AddToLoadForm
                action={addToLoadAction.bind(null, orgSlug, l.id)}
                lists={l.candidates.map((c) => ({
                  value: c.id,
                  label: `${c.number} · ${c.salesOrder.number} · ${c.salesOrder.customer.name}`,
                }))}
              />
            )}
          </Card>
        ) : null}

        {open && l.canDispatch && l.pickLists.length > 0 ? (
          <Card title={t("loads.dispatchTitle")}>
            <p className="text-muted mb-3 text-sm">{t("loads.dispatchHint")}</p>
            <DispatchForm action={dispatchLoadAction.bind(null, orgSlug, l.id)} cold={l.hasCold} />
          </Card>
        ) : null}

        {!open && l.pickLists.length > 0 ? (
          <Card title={t("loads.deliveries")}>
            <ul className="space-y-1 text-sm">
              {l.pickLists.map((p) => (
                <li key={p.id}>
                  <span className="ltr-value font-mono">{p.delivery?.number ?? p.number}</span>
                  {` · ${p.salesOrder.number} · ${p.salesOrder.customer.name}`}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {open && l.canLoad ? (
          <Card title={t("loads.cancel")}>
            <TextReasonForm
              action={cancelLoadAction.bind(null, orgSlug, l.id)}
              name="reason"
              label={t("loads.cancelReason")}
              submitLabel={t("loads.cancel")}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
