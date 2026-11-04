import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CampaignForm } from "@/components/crm/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listCampaigns } from "@/modules/crm/campaigns";
import { listSegments } from "@/modules/crm/segments";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { saveCampaignAction } from "./actions";

const TONE = {
  DRAFT: "neutral",
  SCHEDULED: "warning",
  SENDING: "warning",
  SENT: "success",
  CANCELLED: "muted",
} as const;

/** Messages to customer segments (ADR-119). */
export default async function CampaignsPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/customers/campaigns">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "customers.view")) notFound();
  const [t, list, segments] = await Promise.all([
    getTranslations(),
    listCampaigns(ctx),
    listSegments(ctx),
  ]);
  const base = `/o/${orgSlug}/pos/customers/campaigns`;
  return (
    <>
      <PageHeader title={t("campaigns.title")} description={t("campaigns.hint")} />
      <div className="space-y-6">
        {list.campaigns.length === 0 ? (
          <EmptyState title={t("campaigns.empty")} />
        ) : (
          <Table label={t("campaigns.title")}>
            <thead>
              <tr>
                <Th>{t("campaigns.name")}</Th>
                <Th>{t("campaigns.channel")}</Th>
                <Th>{t("campaigns.segment")}</Th>
                <Th>{t("campaigns.recipients")}</Th>
                <Th>{t("campaigns.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {list.campaigns.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link href={`${base}/${c.id}`} className="text-primary hover:underline">
                      {c.name}
                    </Link>
                  </Td>
                  <Td>{t(`campaigns.channels.${c.channel}`)}</Td>
                  <Td>{c.segment.name}</Td>
                  <Td>{c._count.recipients}</Td>
                  <Td>
                    <Badge tone={TONE[c.status]}>{t(`campaigns.statuses.${c.status}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {list.canManage ? (
          segments.segments.length === 0 ? (
            <EmptyState title={t("campaigns.needSegment")} />
          ) : (
            <Card title={t("campaigns.new")}>
              <CampaignForm
                action={saveCampaignAction.bind(null, orgSlug, null)}
                segments={segments.segments.map((s) => ({
                  value: s.id,
                  label: `${s.name} (${s.withConsent})`,
                }))}
                submitLabel={t("campaigns.saveDraft")}
              />
            </Card>
          )
        ) : null}
      </div>
    </>
  );
}
