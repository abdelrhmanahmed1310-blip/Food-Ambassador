import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ManualMapForm, MapForm } from "@/components/pos/delivery-forms";
import { Card, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { deliveryMaps, mappingTargets } from "@/modules/delivery/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { AppError } from "@/server/errors";
import { removeMapAction, setMapAction } from "../../actions";

/** Map a platform's item and modifier ids to the menu (ADR-069). */
export default async function DeliveryMappingPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/delivery/setup/[connectorId]">) {
  const { orgSlug, connectorId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "menu.manage")) notFound();
  const data = await deliveryMaps(ctx, connectorId).catch((e) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const [t, targets] = await Promise.all([getTranslations(), mappingTargets(ctx)]);
  const items = targets.items.map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }));
  const options = targets.options.map((o) => ({
    value: o.id,
    label: `${o.group.name}: ${o.name}`,
  }));
  const label = new Map([...items, ...options].map((o) => [o.value, o.label]));
  const action = setMapAction.bind(null, orgSlug, connectorId);
  return (
    <>
      <PageHeader
        title={data.connector.name}
        description={t("delivery.mappingIntro")}
        actions={
          <LinkButton
            href={`/o/${orgSlug}/settings/integrations/${connectorId}`}
            variant="secondary"
          >
            {t("delivery.endpointAndSecret")}
          </LinkButton>
        }
      />
      <div className="space-y-6">
        {data.missing.items.length + data.missing.options.length > 0 ? (
          <Card title={t("delivery.toMap")}>
            <ul className="space-y-3">
              {data.missing.items.map((m) => (
                <li key={`i-${m.externalId}`}>
                  <MapForm
                    action={action}
                    kind="ITEM"
                    externalId={m.externalId}
                    options={items}
                    label={`${m.name || m.externalId} (${m.externalId})`}
                  />
                </li>
              ))}
              {data.missing.options.map((m) => (
                <li key={`o-${m.externalId}`}>
                  <MapForm
                    action={action}
                    kind="OPTION"
                    externalId={m.externalId}
                    options={options}
                    label={`${m.name || m.externalId} (${m.externalId})`}
                  />
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <Card title={t("delivery.mappings")}>
          {data.maps.length === 0 ? (
            <p className="text-muted text-sm">{t("delivery.noMappings")}</p>
          ) : (
            <Table label={t("delivery.mappings")}>
              <thead>
                <tr>
                  <Th>{t("delivery.externalId")}</Th>
                  <Th>{t("delivery.mapKind")}</Th>
                  <Th>{t("delivery.target")}</Th>
                  <Th>{t("common.actions")}</Th>
                </tr>
              </thead>
              <tbody>
                {data.maps.map((m) => (
                  <tr key={m.id}>
                    <Td className="ltr-value font-mono">{m.externalId}</Td>
                    <Td>{t(`delivery.mapKinds.${m.kind}`)}</Td>
                    <Td>{label.get(m.targetId) ?? "—"}</Td>
                    <Td>
                      <ConfirmActionButton
                        action={removeMapAction.bind(null, orgSlug, m.id)}
                        label={t("delivery.unmap")}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title={t("delivery.addMapping")}>
          <ManualMapForm action={action} items={items} options={options} />
        </Card>
      </div>
    </>
  );
}
