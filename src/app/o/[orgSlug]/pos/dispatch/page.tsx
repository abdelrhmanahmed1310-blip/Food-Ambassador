import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { TextReasonForm } from "@/components/invoices/forms";
import { DeliveredForm, HomeDeliveryForm } from "@/components/logistics/delivery-forms";
import { PickOneForm } from "@/components/trade/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { canDispatch, dispatchBoard, dispatchBranches } from "@/modules/delivery/home";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import {
  assignRiderAction,
  cancelDeliveryAction,
  createHomeDeliveryAction,
  deliveredAction,
  failedAction,
} from "./actions";

const DELIVERY_TONE = {
  WAITING: "warning",
  ASSIGNED: "neutral",
  OUT: "neutral",
  DELIVERED: "success",
  FAILED: "danger",
  CANCELLED: "muted",
} as const;

/** A branch's own deliveries for the day: addresses, riders and timings (ADR-117). */
export default async function DispatchPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/pos/dispatch">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canDispatch(ctx)) notFound();
  const [t, branches] = await Promise.all([getTranslations(), dispatchBranches(ctx)]);
  if (branches.length === 0) notFound();
  const branchId =
    typeof sp.branch === "string" && isUuid(sp.branch) && branches.some((b) => b.id === sp.branch)
      ? sp.branch
      : branches[0].id;
  const board = await dispatchBoard(
    ctx,
    branchId,
    typeof sp.date === "string" ? sp.date : undefined,
  );
  const fmt = await moneyFormatter(ctx.baseCurrency);
  const riders = board.riders.map((r) => ({ value: r.id, label: `${r.name} (${r.carrying})` }));
  const active = board.deliveries.filter((d) => ["WAITING", "ASSIGNED", "OUT"].includes(d.status));
  const ended = board.deliveries.filter((d) => !["WAITING", "ASSIGNED", "OUT"].includes(d.status));
  return (
    <>
      <PageHeader
        title={t("homeDelivery.dispatchTitle", { branch: board.branch.code })}
        description={t("homeDelivery.dispatchHint")}
      />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("homeDelivery.branch")}</span>
            <select name="branch" defaultValue={branchId} className={`${inputClass} w-auto`}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("homeDelivery.day")}</span>
            <input
              type="date"
              name="date"
              defaultValue={board.date}
              className={`${inputClass} w-auto`}
            />
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            {t("trade.show")}
          </button>
        </form>

        <Card title={t("homeDelivery.needAddress")}>
          {board.ordersWithoutDelivery.length === 0 ? (
            <EmptyState title={t("homeDelivery.noneWaiting")} />
          ) : (
            <ul className="space-y-4">
              {board.ordersWithoutDelivery.map((o) => (
                <li
                  key={o.id}
                  className="border-border rounded-lg border p-4"
                  data-testid={`order-${o.number}`}
                >
                  <p className="mb-2 font-medium">
                    <span className="ltr-value">{o.number}</span> ·{" "}
                    <span className="ltr-value">{fmt.money(o.grossAmount)}</span>
                  </p>
                  <HomeDeliveryForm action={createHomeDeliveryAction.bind(null, orgSlug, o.id)} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t("homeDelivery.active")}>
          {active.length === 0 ? (
            <EmptyState title={t("homeDelivery.noneActive")} />
          ) : (
            <ul className="space-y-4">
              {active.map((d) => (
                <li
                  key={d.id}
                  className="border-border rounded-lg border p-4"
                  data-testid={`delivery-${d.posOrder.number}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      <span className="ltr-value">{d.posOrder.number}</span> ·{" "}
                      {d.contactName ?? "—"} · {d.address}
                    </p>
                    <span className="flex gap-2">
                      <Badge tone={DELIVERY_TONE[d.status]}>
                        {t(`homeDelivery.statuses.${d.status}`)}
                      </Badge>
                      {d.posOrder.status === "VOIDED" ? (
                        <Badge tone="danger">{t("homeDelivery.voided")}</Badge>
                      ) : null}
                    </span>
                  </div>
                  <p className="text-muted text-sm">
                    {d.rider
                      ? t("homeDelivery.withRider", { name: d.rider.name })
                      : t("homeDelivery.noRider")}{" "}
                    · {t("homeDelivery.minutesSince", { minutes: d.minutesSinceOrder ?? 0 })}
                  </p>
                  <div className="mt-3 grid gap-4 lg:grid-cols-2">
                    {d.status === "WAITING" || d.status === "ASSIGNED" ? (
                      <>
                        {riders.length > 0 ? (
                          <PickOneForm
                            action={assignRiderAction.bind(null, orgSlug, d.id)}
                            name="riderUserId"
                            label={t("homeDelivery.rider")}
                            options={riders}
                            submitLabel={
                              d.rider ? t("homeDelivery.reassign") : t("homeDelivery.assign")
                            }
                          />
                        ) : (
                          <p className="text-muted text-sm">{t("homeDelivery.noRiders")}</p>
                        )}
                        <TextReasonForm
                          action={cancelDeliveryAction.bind(null, orgSlug, d.id)}
                          name="reason"
                          label={t("homeDelivery.cancelReason")}
                          submitLabel={t("homeDelivery.cancel")}
                          variant="danger"
                        />
                      </>
                    ) : (
                      <>
                        <DeliveredForm action={deliveredAction.bind(null, orgSlug, d.id)} />
                        <TextReasonForm
                          action={failedAction.bind(null, orgSlug, d.id)}
                          name="reason"
                          label={t("homeDelivery.failureReason")}
                          submitLabel={t("homeDelivery.failed")}
                          variant="danger"
                        />
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t("homeDelivery.riders")}>
          {board.riders.length === 0 ? (
            <EmptyState title={t("homeDelivery.noRiders")} />
          ) : (
            <Table label={t("homeDelivery.riders")}>
              <thead>
                <tr>
                  <Th>{t("homeDelivery.rider")}</Th>
                  <Th>{t("homeDelivery.carrying")}</Th>
                  <Th>{t("homeDelivery.deliveredCount")}</Th>
                  <Th>{t("homeDelivery.failedCount")}</Th>
                  <Th>{t("homeDelivery.medianRoad")}</Th>
                  <Th>{t("homeDelivery.medianTotal")}</Th>
                </tr>
              </thead>
              <tbody>
                {board.riders.map((r) => (
                  <tr key={r.id} data-testid={`rider-${r.name}`}>
                    <Td>{r.name}</Td>
                    <Td>{r.carrying}</Td>
                    <Td>{r.stats?.delivered ?? 0}</Td>
                    <Td>{r.stats?.failed ?? 0}</Td>
                    <Td>{r.stats?.medianRoadMinutes ?? "—"}</Td>
                    <Td>{r.stats?.medianTotalMinutes ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {ended.length > 0 ? (
          <Card title={t("homeDelivery.ended")}>
            <Table label={t("homeDelivery.ended")}>
              <thead>
                <tr>
                  <Th>{t("homeDelivery.order")}</Th>
                  <Th>{t("homeDelivery.rider")}</Th>
                  <Th>{t("homeDelivery.status")}</Th>
                  <Th>{t("homeDelivery.totalMinutes")}</Th>
                  <Th>{t("homeDelivery.note")}</Th>
                </tr>
              </thead>
              <tbody>
                {ended.map((d) => (
                  <tr key={d.id}>
                    <Td>
                      <span className="ltr-value">{d.posOrder.number}</span>
                    </Td>
                    <Td>{d.rider?.name ?? "—"}</Td>
                    <Td>
                      <Badge tone={DELIVERY_TONE[d.status]}>
                        {t(`homeDelivery.statuses.${d.status}`)}
                      </Badge>
                    </Td>
                    <Td>{d.totalMinutes ?? "—"}</Td>
                    <Td>{d.failureReason ?? d.cancelReason ?? d.recipientName ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : null}
      </div>
    </>
  );
}
