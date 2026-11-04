import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { AttachmentsCard } from "@/components/attachments/attachments-card";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { TextReasonForm } from "@/components/invoices/forms";
import { DeliverForm, OdometerForm, ReadingForm } from "@/components/logistics/forms";
import { SignatureView } from "@/components/logistics/signature-pad";
import { PickOneForm } from "@/components/trade/forms";
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
import { getTrip } from "@/modules/logistics/trips";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  addStopAction,
  cancelTripAction,
  completeTripAction,
  deliverStopAction,
  failStopAction,
  recordReadingAction,
  removeStopAction,
  startTripAction,
} from "../../actions";

const TONE = {
  PLANNED: "neutral",
  IN_PROGRESS: "warning",
  COMPLETED: "success",
  CANCELLED: "muted",
} as const;
const STOP_TONE = { PENDING: "neutral", DELIVERED: "success", FAILED: "danger" } as const;

/** One trip: its stops with proof of delivery, temperatures and the driver's steps (ADR-116). */
export default async function TripPage({
  params,
}: PageProps<"/o/[orgSlug]/logistics/trips/[tripId]">) {
  const { orgSlug, tripId } = await params;
  const ctx = await requireTenant(orgSlug);
  const trip = await notFoundOnAppError(getTrip(ctx, tripId));
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const time = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "short", timeStyle: "short" }) : "—";
  const onRoad = trip.status === "IN_PROGRESS" && trip.canDeliver;
  const range = trip.vehicle.refrigerated
    ? `${trip.vehicle.minTemperatureC?.toString()} … ${trip.vehicle.maxTemperatureC?.toString()} °C`
    : t("logistics.ambient");
  return (
    <>
      <PageHeader
        title={`${trip.number} — ${trip.vehicle.code}`}
        description={t("logistics.tripHint")}
        actions={
          <span className="flex flex-wrap gap-2">
            <Badge tone={TONE[trip.status]}>{t(`logistics.statuses.${trip.status}`)}</Badge>
            {trip.excursions > 0 ? (
              <Badge tone="danger">{t("logistics.excursions", { count: trip.excursions })}</Badge>
            ) : null}
          </span>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("logistics.fromWarehouse"),
                value: `${trip.warehouse.code} — ${trip.warehouse.name}`,
              },
              {
                label: t("logistics.vehicle"),
                value: (
                  <span className="ltr-value">{`${trip.vehicle.code} · ${trip.vehicle.plateNumber}`}</span>
                ),
              },
              { label: t("logistics.range"), value: <span className="ltr-value">{range}</span> },
              { label: t("logistics.driver"), value: trip.driver.name },
              {
                label: t("logistics.plannedOn"),
                value: <span className="ltr-value">{trip.plannedOn}</span>,
              },
              { label: t("logistics.started"), value: time(trip.startedAt) },
              { label: t("logistics.completed"), value: time(trip.completedAt) },
              {
                label: t("logistics.distance"),
                value:
                  trip.distanceKm === null ? (
                    "—"
                  ) : (
                    <span className="ltr-value">{`${trip.distanceKm} km`}</span>
                  ),
              },
              ...(trip.cancelReason
                ? [{ label: t("logistics.cancelReason"), value: trip.cancelReason }]
                : []),
            ]}
          />
        </Card>

        {trip.status === "PLANNED" && trip.canDeliver && trip.stops.length > 0 ? (
          <Card title={t("logistics.start")}>
            <OdometerForm
              action={startTripAction.bind(null, orgSlug, trip.id)}
              name="startOdometerKm"
              submitLabel={t("logistics.start")}
            />
          </Card>
        ) : null}

        <Card title={t("logistics.stops")}>
          {trip.stops.length === 0 ? (
            <EmptyState title={t("logistics.noStops")} />
          ) : (
            <ol className="space-y-4">
              {trip.stops.map((s) => {
                const d = s.customerDelivery;
                const sh = s.stockShipment;
                const c = d?.order.customer;
                return (
                  <li
                    key={s.id}
                    className="border-border rounded-lg border p-4"
                    data-testid={`stop-${s.sequence}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">
                        {s.sequence}.{" "}
                        {c
                          ? `${c.code} — ${c.name}`
                          : sh
                            ? `${t("logistics.transferTo")} ${sh.to.code} — ${sh.to.name}`
                            : ""}
                      </p>
                      <Badge tone={STOP_TONE[s.status]}>
                        {t(`logistics.stopStatuses.${s.status}`)}
                      </Badge>
                    </div>
                    <p className="text-muted text-sm">
                      {d ? (
                        <>
                          <span className="ltr-value">{d.number}</span>
                          {c && (c.street || c.city)
                            ? ` · ${[c.street, c.district, c.city].filter(Boolean).join(", ")}`
                            : ""}
                          {c?.phone ? <span className="ltr-value"> · {c.phone}</span> : null}
                        </>
                      ) : sh ? (
                        <span className="ltr-value">{sh.number}</span>
                      ) : null}
                    </p>
                    {s.status === "DELIVERED" ? (
                      <div className="mt-2 flex flex-wrap items-end gap-4 text-sm">
                        <span>
                          {t("logistics.receivedBy", { name: s.recipientName ?? "" })} ·{" "}
                          {time(s.deliveredAt)}
                          {s.handoverTemperatureC !== null ? (
                            <span className="ltr-value">{` · ${s.handoverTemperatureC.toString()} °C`}</span>
                          ) : null}
                        </span>
                        {s.signatureSvg ? <SignatureView path={s.signatureSvg} /> : null}
                      </div>
                    ) : null}
                    {s.status === "FAILED" ? (
                      <p className="mt-2 text-sm">
                        {t("logistics.failedBecause", { reason: s.failureReason ?? "" })}
                      </p>
                    ) : null}
                    {trip.canPlan ? (
                      <div className="mt-2">
                        <ConfirmActionButton
                          action={removeStopAction.bind(null, orgSlug, trip.id, s.id)}
                          label={t("logistics.removeStop")}
                          variant="secondary"
                        />
                      </div>
                    ) : null}
                    {onRoad && s.status === "PENDING" ? (
                      <div className="mt-4 grid gap-6 lg:grid-cols-2">
                        <div>
                          <h3 className="mb-2 text-sm font-medium">
                            {t("logistics.proofOfDelivery")}
                          </h3>
                          <DeliverForm
                            action={deliverStopAction.bind(null, orgSlug, trip.id, s.id)}
                            needsTemperature={trip.vehicle.refrigerated}
                          />
                        </div>
                        <div>
                          <h3 className="mb-2 text-sm font-medium">
                            {t("logistics.notDelivered")}
                          </h3>
                          <TextReasonForm
                            action={failStopAction.bind(null, orgSlug, trip.id, s.id)}
                            name="reason"
                            label={t("logistics.failureReason")}
                            submitLabel={t("logistics.markFailed")}
                            variant="danger"
                          />
                        </div>
                      </div>
                    ) : null}
                    {s.status !== "PENDING" || onRoad ? (
                      <div className="mt-3">
                        <AttachmentsCard
                          ctx={ctx}
                          orgSlug={orgSlug}
                          entityType="TRIP_STOP"
                          entityId={s.id}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
          {trip.canPlan ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {trip.consignments.deliveries.length > 0 ? (
                <PickOneForm
                  action={addStopAction.bind(null, orgSlug, trip.id, "CUSTOMER_DELIVERY")}
                  name="consignmentId"
                  label={t("logistics.addDelivery")}
                  options={trip.consignments.deliveries.map((d) => ({
                    value: d.id,
                    label: `${d.number} — ${d.order.customer.code}`,
                  }))}
                  submitLabel={t("logistics.addStop")}
                />
              ) : null}
              {trip.consignments.transfers.length > 0 ? (
                <PickOneForm
                  action={addStopAction.bind(null, orgSlug, trip.id, "TRANSFER")}
                  name="consignmentId"
                  label={t("logistics.addTransfer")}
                  options={trip.consignments.transfers.map((x) => ({
                    value: x.id,
                    label: `${x.number} → ${x.to.code}`,
                  }))}
                  submitLabel={t("logistics.addStop")}
                />
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card title={t("logistics.temperatures")}>
          {trip.readings.length === 0 ? (
            <EmptyState title={t("logistics.noReadings")} />
          ) : (
            <Table label={t("logistics.temperatures")}>
              <thead>
                <tr>
                  <Th>{t("logistics.readAt")}</Th>
                  <Th>{t("logistics.temperature")}</Th>
                  <Th>{t("logistics.note")}</Th>
                </tr>
              </thead>
              <tbody>
                {trip.readings.map((r) => (
                  <tr key={r.id}>
                    <Td>{time(r.readAt)}</Td>
                    <Td>
                      <span className="ltr-value">{`${r.temperatureC.toString()} °C`}</span>{" "}
                      {r.excursion ? <Badge tone="danger">{t("logistics.excursion")}</Badge> : null}
                    </Td>
                    <Td>{r.note ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {onRoad ? (
            <div className="mt-4">
              <ReadingForm action={recordReadingAction.bind(null, orgSlug, trip.id)} />
            </div>
          ) : null}
        </Card>

        {onRoad ? (
          <Card title={t("logistics.complete")}>
            <OdometerForm
              action={completeTripAction.bind(null, orgSlug, trip.id)}
              name="endOdometerKm"
              submitLabel={t("logistics.complete")}
            />
          </Card>
        ) : null}

        {trip.canPlan ? (
          <Card title={t("logistics.cancel")}>
            <TextReasonForm
              action={cancelTripAction.bind(null, orgSlug, trip.id)}
              name="reason"
              label={t("logistics.cancelReason")}
              submitLabel={t("logistics.cancel")}
              variant="danger"
            />
          </Card>
        ) : null}
        <p className="text-sm">
          <Link href={`/o/${orgSlug}/logistics/trips`} className="text-primary hover:underline">
            {t("logistics.allTrips")}
          </Link>
        </p>
      </div>
    </>
  );
}
