import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { VehicleForm } from "@/components/logistics/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import {
  canPlanTrips,
  canSeeLogistics,
  listVehicles,
  tripFormOptions,
} from "@/modules/logistics/trips";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createVehicleAction, setVehicleArchivedAction } from "../actions";

/** The organization's own vehicles (ADR-116). */
export default async function VehiclesPage({
  params,
}: PageProps<"/o/[orgSlug]/logistics/vehicles">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeLogistics(ctx)) notFound();
  const [t, vehicles, options] = await Promise.all([
    getTranslations(),
    listVehicles(ctx),
    canPlanTrips(ctx) ? tripFormOptions(ctx) : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader title={t("logistics.vehiclesTitle")} description={t("logistics.vehiclesHint")} />
      <div className="space-y-6">
        {vehicles.length === 0 ? (
          <EmptyState title={t("logistics.noVehicles")} />
        ) : (
          <Table label={t("logistics.vehiclesTitle")}>
            <thead>
              <tr>
                <Th>{t("logistics.code")}</Th>
                <Th>{t("logistics.plate")}</Th>
                <Th>{t("logistics.type")}</Th>
                <Th>{t("logistics.base")}</Th>
                <Th>{t("logistics.range")}</Th>
                <Th>{""}</Th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => {
                const manage = hasPermission(ctx.grants, "logistics.manage", {
                  warehouseId: v.warehouseId,
                  branchId: v.warehouse.branchId,
                });
                return (
                  <tr key={v.id} className={v.archivedAt ? "opacity-60" : undefined}>
                    <Td>
                      <span className="ltr-value font-mono">{v.code}</span>
                    </Td>
                    <Td>
                      <span className="ltr-value">{v.plateNumber}</span>
                    </Td>
                    <Td>{t(`logistics.types.${v.type}`)}</Td>
                    <Td>{v.warehouse.code}</Td>
                    <Td>
                      {v.refrigerated ? (
                        <span className="ltr-value">{`${v.minTemperatureC?.toString()} … ${v.maxTemperatureC?.toString()} °C`}</span>
                      ) : (
                        <Badge tone="muted">{t("logistics.ambient")}</Badge>
                      )}
                    </Td>
                    <Td>
                      {manage ? (
                        <ConfirmActionButton
                          action={setVehicleArchivedAction.bind(null, orgSlug, v.id, !v.archivedAt)}
                          label={v.archivedAt ? t("logistics.restore") : t("logistics.archive")}
                          variant="secondary"
                        />
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        {options && options.warehouses.length > 0 ? (
          <Card title={t("logistics.addVehicle")}>
            <VehicleForm
              action={createVehicleAction.bind(null, orgSlug)}
              warehouses={options.warehouses.map((w) => ({
                value: w.id,
                label: `${w.code} — ${w.name}`,
              }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
