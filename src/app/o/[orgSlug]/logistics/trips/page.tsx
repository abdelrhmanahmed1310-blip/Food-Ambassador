import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { canPlanTrips, canSeeLogistics, listTrips } from "@/modules/logistics/trips";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const TRIP_TONE = {
  PLANNED: "neutral",
  IN_PROGRESS: "warning",
  COMPLETED: "success",
  CANCELLED: "muted",
} as const;

/** Delivery trips of the own fleet (ADR-116). */
export default async function TripsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/logistics/trips">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeLogistics(ctx)) notFound();
  const date = typeof sp.date === "string" ? sp.date : "";
  const mine = sp.mine === "1";
  const [t, trips] = await Promise.all([getTranslations(), listTrips(ctx, { date, mine })]);
  const base = `/o/${orgSlug}/logistics/trips`;
  return (
    <>
      <PageHeader
        title={t("logistics.tripsTitle")}
        description={t("logistics.tripsHint")}
        actions={
          canPlanTrips(ctx) ? (
            <Link href={`${base}/new`} className={buttonClass("primary")}>
              {t("logistics.newTrip")}
            </Link>
          ) : null
        }
      />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("logistics.plannedOn")}</span>
            <input type="date" name="date" defaultValue={date} className={`${inputClass} w-auto`} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="mine" value="1" defaultChecked={mine} />
            {t("logistics.mine")}
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            {t("trade.show")}
          </button>
        </form>
        {trips.length === 0 ? (
          <EmptyState title={t("logistics.noTrips")} />
        ) : (
          <Table label={t("logistics.tripsTitle")}>
            <thead>
              <tr>
                <Th>{t("logistics.number")}</Th>
                <Th>{t("logistics.plannedOn")}</Th>
                <Th>{t("logistics.vehicle")}</Th>
                <Th>{t("logistics.driver")}</Th>
                <Th>{t("logistics.stops")}</Th>
                <Th>{t("logistics.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {trips.map((x) => (
                <tr key={x.id} data-testid={`trip-${x.number}`}>
                  <Td>
                    <Link
                      href={`${base}/${x.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {x.number}
                    </Link>
                  </Td>
                  <Td>
                    <span className="ltr-value">{x.plannedOn}</span>
                  </Td>
                  <Td>
                    {x.vehicle.code}{" "}
                    <span className="ltr-value text-muted text-xs">{x.vehicle.plateNumber}</span>
                  </Td>
                  <Td>{x.driver.name}</Td>
                  <Td>
                    {t("logistics.stopCounts", {
                      delivered: x.delivered,
                      failed: x.failed,
                      total: x.stopCount,
                    })}
                  </Td>
                  <Td>
                    <Badge tone={TRIP_TONE[x.status]}>{t(`logistics.statuses.${x.status}`)}</Badge>
                    {x.excursions > 0 ? (
                      <span className="block">
                        <Badge tone="danger">
                          {t("logistics.excursions", { count: x.excursions })}
                        </Badge>
                      </span>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
