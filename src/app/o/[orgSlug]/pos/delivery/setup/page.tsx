import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DeliveryConnectorForm } from "@/components/pos/delivery-forms";
import { Badge, Card, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { ADAPTERS, DELIVERY_PLATFORMS } from "@/modules/delivery/adapters";
import { listDeliveryConnectors } from "@/modules/delivery/service";
import { listRegisters } from "@/modules/pos/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createDeliveryConnectorAction } from "../actions";

/** Delivery platforms: one connector per platform and register, and how each connects (ADR-069). */
export default async function DeliverySetupPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/delivery/setup">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const manage = hasPermission(ctx.grants, "integrations.manage");
  if (!manage && !hasPermission(ctx.grants, "menu.manage")) notFound();
  const [t, connectors, registers] = await Promise.all([
    getTranslations(),
    listDeliveryConnectors(ctx),
    listRegisters(ctx),
  ]);
  const registerName = new Map(registers.map((r) => [r.id, `${r.code} — ${r.name}`]));
  return (
    <>
      <PageHeader title={t("delivery.setupTitle")} description={t("delivery.setupIntro")} />
      <div className="space-y-6">
        <Card title={t("delivery.connectors")}>
          {connectors.length === 0 ? (
            <p className="text-muted text-sm">{t("delivery.noConnectors")}</p>
          ) : (
            <Table label={t("delivery.connectors")}>
              <thead>
                <tr>
                  <Th>{t("delivery.connectorName")}</Th>
                  <Th>{t("delivery.platform")}</Th>
                  <Th>{t("delivery.register")}</Th>
                  <Th>{t("delivery.autoAcceptShort")}</Th>
                  <Th>{t("delivery.mappings")}</Th>
                  <Th>{t("pos.status")}</Th>
                </tr>
              </thead>
              <tbody>
                {connectors.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/pos/delivery/setup/${c.id}`}
                        className="text-primary hover:underline"
                      >
                        {c.name}
                      </Link>
                    </Td>
                    <Td>{t(`delivery.platforms.${c.config.platform}`)}</Td>
                    <Td>{registerName.get(c.config.registerId) ?? "—"}</Td>
                    <Td>{c.config.autoAccept ? t("common.yes") : t("common.no")}</Td>
                    <Td className="tabular-nums">{c._count.itemMaps}</Td>
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
        </Card>
        <Card title={t("delivery.howItConnects")}>
          <ul className="space-y-2 text-sm">
            {DELIVERY_PLATFORMS.map((p) => (
              <li key={p}>
                <span className="font-medium">{t(`delivery.platforms.${p}`)}</span> —{" "}
                {ADAPTERS[p].native ? t("delivery.native") : t("delivery.canonicalOnly")}{" "}
                <span className="text-muted">({ADAPTERS[p].specification})</span>
              </li>
            ))}
          </ul>
        </Card>
        {manage ? (
          <Card title={t("delivery.addConnector")}>
            <DeliveryConnectorForm
              action={createDeliveryConnectorAction.bind(null, orgSlug)}
              platforms={DELIVERY_PLATFORMS.map((p) => ({
                value: p,
                label: t(`delivery.platforms.${p}`),
              }))}
              registers={registers.map((r) => ({
                value: r.id,
                label: `${r.code} — ${r.name} (${r.branch.name})`,
              }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
