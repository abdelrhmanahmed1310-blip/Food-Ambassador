import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { TripForm } from "@/components/logistics/forms";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { businessDate } from "@/modules/inventory/rules";
import { canPlanTrips, tripFormOptions } from "@/modules/logistics/trips";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createTripAction } from "../../actions";

/** Plan a trip: the warehouse first, then its vehicles and drivers. */
export default async function NewTripPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/logistics/trips/new">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canPlanTrips(ctx)) notFound();
  const [t, options] = await Promise.all([getTranslations(), tripFormOptions(ctx)]);
  const warehouse =
    options.warehouses.find((w) => w.id === sp.warehouse) ??
    (options.warehouses.length === 1 ? options.warehouses[0] : null);
  const vehicles = warehouse ? options.vehicles.filter((v) => v.warehouseId === warehouse.id) : [];
  const drivers = warehouse ? (options.drivers[warehouse.id] ?? []) : [];
  return (
    <>
      <PageHeader title={t("logistics.newTrip")} description={t("logistics.newTripHint")} />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("logistics.fromWarehouse")}</span>
            <select
              name="warehouse"
              defaultValue={warehouse?.id ?? ""}
              className={`${inputClass} w-auto`}
            >
              <option value="">—</option>
              {options.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            {t("logistics.choose")}
          </button>
        </form>
        {warehouse ? (
          vehicles.length === 0 || drivers.length === 0 ? (
            <EmptyState
              title={
                vehicles.length === 0 ? t("logistics.noVehiclesHere") : t("logistics.noDriversHere")
              }
            />
          ) : (
            <Card title={`${warehouse.code} — ${warehouse.name}`}>
              <TripForm
                action={createTripAction.bind(null, orgSlug, warehouse.id)}
                vehicles={vehicles.map((v) => ({
                  value: v.id,
                  label: `${v.code} — ${v.plateNumber}`,
                }))}
                drivers={drivers.map((d) => ({ value: d.id, label: `${d.name} (${d.email})` }))}
                date={businessDate(ctx.timeZone)}
              />
            </Card>
          )
        ) : null}
      </div>
    </>
  );
}
