import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { CreateConnectorForm } from "@/components/integrations/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listConnectors, OUTBOUND_EVENTS } from "@/modules/integrations/service";
import { purchasingWarehouseOptions } from "@/modules/procurement/orders";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createConnectorAction } from "./actions";

export default async function IntegrationsPage({
  params,
}: PageProps<"/o/[orgSlug]/settings/integrations">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "integrations.manage")) notFound();
  const [t, format, connectors, warehouses] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listConnectors(ctx),
    purchasingWarehouseOptions(ctx, "sales.import"),
  ]);
  const base = `/o/${orgSlug}/settings/integrations`;
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.intro")} />
      <Card title={t("integrations.newConnector")}>
        <CreateConnectorForm
          action={createConnectorAction.bind(null, orgSlug)}
          orgSlug={orgSlug}
          warehouses={warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
          events={[...OUTBOUND_EVENTS]}
        />
      </Card>
      <div className="mt-6">
        {connectors.length === 0 ? (
          <EmptyState title={t("integrations.empty")} />
        ) : (
          <Table label={t("integrations.title")}>
            <thead>
              <tr>
                <Th>{t("integrations.name")}</Th>
                <Th>{t("integrations.kind")}</Th>
                <Th>{t("integrations.secret")}</Th>
                <Th>{t("integrations.created")}</Th>
                <Th>{t("integrations.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {connectors.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link className="text-primary underline" href={`${base}/${c.id}`}>
                      {c.name}
                    </Link>
                  </Td>
                  <Td>{t(`integrations.kinds.${c.kind}`)}</Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{c.secretHint}</span>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {format.dateTime(c.createdAt, { dateStyle: "medium", timeZone: ctx.timeZone })}
                  </Td>
                  <Td>
                    <Badge tone={c.status === "ACTIVE" ? "success" : "muted"}>
                      {t(`integrations.statuses.${c.status}`)}
                    </Badge>
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
