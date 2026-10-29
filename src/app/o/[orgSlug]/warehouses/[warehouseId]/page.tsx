import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { LocationForm, WarehouseForm } from "@/components/sites/warehouse-forms";
import {
  Badge,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getWarehouse } from "@/modules/sites/warehouses";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { warehouseOptions } from "@/server/labels";
import {
  createLocationAction,
  setLocationArchivedAction,
  setWarehouseArchivedAction,
  updateLocationAction,
  updateWarehouseAction,
} from "../actions";

export default async function WarehousePage({
  params,
}: PageProps<"/o/[orgSlug]/warehouses/[warehouseId]">) {
  const { orgSlug, warehouseId } = await params;
  if (!isUuid(warehouseId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const warehouse = await notFoundOnAppError(getWarehouse(ctx, warehouseId));
  const [t, { types, zones }] = await Promise.all([getTranslations(), warehouseOptions()]);
  const archived = warehouse.archivedAt !== null;
  const locationLabels = {
    pending: t("common.saving"),
    code: t("warehouses.locationCode"),
    name: t("warehouses.locationName"),
    zone: t("warehouses.temperatureZone"),
  };

  return (
    <>
      <PageHeader
        title={warehouse.name}
        description={`${warehouse.branch.code} — ${warehouse.branch.name}`}
        actions={archived ? <Badge tone="muted">{t("common.archived")}</Badge> : undefined}
      />
      <div className="space-y-6">
        {warehouse.canManage ? (
          <Card title={t("warehouses.editTitle")}>
            <WarehouseForm
              action={updateWarehouseAction.bind(null, orgSlug, warehouse.id)}
              labels={{
                submit: t("common.save"),
                pending: t("common.saving"),
                code: t("warehouses.code"),
                name: t("warehouses.name"),
                type: t("warehouses.type"),
                branch: t("warehouses.branch"),
              }}
              types={types}
              defaults={{ code: warehouse.code, name: warehouse.name, type: warehouse.type }}
            />
          </Card>
        ) : (
          <Card>
            <DescriptionList
              items={[
                {
                  label: t("warehouses.code"),
                  value: <span className="ltr-value font-mono">{warehouse.code}</span>,
                },
                { label: t("warehouses.type"), value: t(`warehouses.types.${warehouse.type}`) },
                {
                  label: t("warehouses.branch"),
                  value: (
                    <Link
                      className="text-primary hover:underline"
                      href={`/o/${orgSlug}/branches/${warehouse.branch.id}`}
                    >
                      {warehouse.branch.name}
                    </Link>
                  ),
                },
              ]}
            />
          </Card>
        )}

        <Card title={t("warehouses.locations")}>
          <p className="text-muted mb-4 text-sm">{t("warehouses.locationsHint")}</p>
          {warehouse.locations.length === 0 ? (
            <p className="text-muted mb-4 text-sm">{t("warehouses.noLocations")}</p>
          ) : (
            <div className="mb-4">
              <Table label={t("warehouses.locations")}>
                <thead>
                  <tr>
                    <Th>{t("warehouses.locationCode")}</Th>
                    <Th>{t("warehouses.locationName")}</Th>
                    <Th>{t("warehouses.temperatureZone")}</Th>
                    <Th>{t("common.status")}</Th>
                    {warehouse.canManage ? <Th>{t("common.actions")}</Th> : null}
                  </tr>
                </thead>
                <tbody>
                  {warehouse.locations.map((loc) => (
                    <tr key={loc.id}>
                      <Td>
                        <span className="ltr-value font-mono text-xs">{loc.code}</span>
                      </Td>
                      <Td>{loc.name}</Td>
                      <Td>{t(`warehouses.zones.${loc.temperatureZone}`)}</Td>
                      <Td>
                        {loc.archivedAt ? (
                          <Badge tone="muted">{t("common.archived")}</Badge>
                        ) : (
                          <Badge tone="success">{t("common.active")}</Badge>
                        )}
                      </Td>
                      {warehouse.canManage ? (
                        <Td>
                          <div className="flex flex-col gap-2">
                            <details>
                              <summary className="text-primary cursor-pointer text-sm">
                                {t("common.edit")}
                              </summary>
                              <div className="mt-2 min-w-72">
                                <LocationForm
                                  action={updateLocationAction.bind(null, orgSlug, loc.id)}
                                  labels={{ ...locationLabels, submit: t("common.save") }}
                                  zones={zones}
                                  defaults={{
                                    code: loc.code,
                                    name: loc.name,
                                    temperatureZone: loc.temperatureZone,
                                  }}
                                />
                              </div>
                            </details>
                            {loc.archivedAt ? (
                              <ConfirmActionButton
                                action={setLocationArchivedAction.bind(
                                  null,
                                  orgSlug,
                                  loc.id,
                                  false,
                                )}
                                label={t("common.restore")}
                                variant="secondary"
                              />
                            ) : (
                              <ConfirmActionButton
                                action={setLocationArchivedAction.bind(null, orgSlug, loc.id, true)}
                                label={t("common.archive")}
                                confirmMessage={t("confirm.archiveLocation")}
                              />
                            )}
                          </div>
                        </Td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          {warehouse.canManage && !archived ? (
            <div className="border-border border-t pt-4">
              <h3 className="mb-3 text-sm font-semibold">{t("warehouses.addLocation")}</h3>
              <LocationForm
                action={createLocationAction.bind(null, orgSlug, warehouse.id)}
                labels={{ ...locationLabels, submit: t("warehouses.addLocation") }}
                zones={zones}
                idempotent
              />
            </div>
          ) : null}
        </Card>

        {warehouse.canManage ? (
          <Card>
            {archived ? (
              <ConfirmActionButton
                action={setWarehouseArchivedAction.bind(null, orgSlug, warehouse.id, false)}
                label={t("common.restore")}
                variant="secondary"
              />
            ) : (
              <ConfirmActionButton
                action={setWarehouseArchivedAction.bind(null, orgSlug, warehouse.id, true)}
                label={t("common.archive")}
                confirmMessage={t("confirm.archiveWarehouse")}
              />
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
