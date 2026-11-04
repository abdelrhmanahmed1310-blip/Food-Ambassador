import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { TextReasonForm } from "@/components/invoices/forms";
import { DeliveredForm } from "@/components/logistics/delivery-forms";
import { Badge, EmptyState, PageHeader } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { canRide, myDeliveries } from "@/modules/delivery/home";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { deliveredAction, failedAction, pickUpAction } from "../dispatch/actions";

/** The rider's phone screen: what to deliver, where, and the steps (ADR-117). */
export default async function RiderPage({ params }: PageProps<"/o/[orgSlug]/pos/rider">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canRide(ctx)) notFound();
  const [t, rows] = await Promise.all([getTranslations(), myDeliveries(ctx)]);
  const todo = rows.filter((d) => d.status === "ASSIGNED" || d.status === "OUT");
  const done = rows.filter((d) => d.status !== "ASSIGNED" && d.status !== "OUT");
  return (
    <>
      <PageHeader title={t("homeDelivery.riderTitle")} description={t("homeDelivery.riderHint")} />
      <div className="space-y-4">
        {todo.length === 0 ? <EmptyState title={t("homeDelivery.nothingToDeliver")} /> : null}
        {todo.map((d) => (
          <section
            key={d.id}
            className="border-border bg-surface rounded-xl border p-4 shadow-sm"
            data-testid={`ride-${d.posOrder.number}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">
                <span className="ltr-value">{d.posOrder.number}</span> · {d.branch.code}
              </p>
              <Badge tone={d.status === "OUT" ? "warning" : "neutral"}>
                {t(`homeDelivery.statuses.${d.status}`)}
              </Badge>
            </div>
            <p className="mt-2">{d.contactName ?? "—"}</p>
            <p className="text-lg">{d.address}</p>
            {d.directions ? <p className="text-muted text-sm">{d.directions}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {d.phone ? (
                <a
                  href={`tel:${d.phone.replace(/[^+\d]/g, "")}`}
                  className={buttonClass("secondary")}
                >
                  <span className="ltr-value">{d.phone}</span>
                </a>
              ) : null}
              {d.mapUrl ? (
                <a
                  href={d.mapUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClass("secondary")}
                >
                  {t("homeDelivery.openMap")}
                </a>
              ) : null}
            </div>
            {d.posOrder.status === "VOIDED" ? (
              <p className="mt-3 text-sm">
                <Badge tone="danger">{t("homeDelivery.voided")}</Badge>{" "}
                {t("homeDelivery.voidedHint")}
              </p>
            ) : d.status === "ASSIGNED" ? (
              <div className="mt-3">
                <ConfirmActionButton
                  action={pickUpAction.bind(null, orgSlug, d.id)}
                  label={t("homeDelivery.pickedUp")}
                  variant="primary"
                />
              </div>
            ) : (
              <div className="mt-3 grid gap-4">
                <DeliveredForm action={deliveredAction.bind(null, orgSlug, d.id)} />
                <TextReasonForm
                  action={failedAction.bind(null, orgSlug, d.id)}
                  name="reason"
                  label={t("homeDelivery.failureReason")}
                  submitLabel={t("homeDelivery.failed")}
                  variant="danger"
                />
              </div>
            )}
          </section>
        ))}
        {done.length > 0 ? (
          <section>
            <h2 className="mb-2 text-sm font-medium">{t("homeDelivery.recent")}</h2>
            <ul className="space-y-1 text-sm">
              {done.map((d) => (
                <li key={d.id}>
                  <span className="ltr-value">{d.posOrder.number}</span> —{" "}
                  {t(`homeDelivery.statuses.${d.status}`)}
                  {d.totalMinutes !== null
                    ? ` · ${t("homeDelivery.minutes", { minutes: d.totalMinutes })}`
                    : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}
