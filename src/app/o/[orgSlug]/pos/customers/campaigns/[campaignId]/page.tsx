import { getTranslations } from "next-intl/server";
import { CampaignForm, LaunchForm } from "@/components/crm/forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Alert, Badge, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { getCampaign } from "@/modules/crm/campaigns";
import { listSegments } from "@/modules/crm/segments";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter } from "@/server/inventory-view";
import { cancelCampaignAction, launchCampaignAction, saveCampaignAction } from "../actions";

/** One campaign: who it reaches, what they will read, and how it went (ADR-119). */
export default async function CampaignPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/customers/campaigns/[campaignId]">) {
  const { orgSlug, campaignId } = await params;
  const ctx = await requireTenant(orgSlug);
  const c = await notFoundOnAppError(getCampaign(ctx, campaignId));
  const [t, segments, fmt] = await Promise.all([
    getTranslations(),
    listSegments(ctx),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const channel = t(`campaigns.channels.${c.channel}`);
  return (
    <>
      <PageHeader
        title={c.name}
        description={t("campaigns.detailHint", { channel, segment: c.segment.name })}
        actions={
          <Badge tone={c.status === "SENT" ? "success" : "neutral"}>
            {t(`campaigns.statuses.${c.status}`)}
          </Badge>
        }
      />
      <div className="space-y-6">
        {!c.provider && (c.status === "DRAFT" || c.status === "SCHEDULED") ? (
          <Alert tone="info">{t("campaigns.noProvider", { channel })}</Alert>
        ) : null}
        {c.audience ? (
          <Card title={t("campaigns.audience")}>
            <DescriptionList
              items={[
                { label: t("campaigns.inSegment"), value: c.audience.inSegment },
                { label: t("campaigns.consenting"), value: c.audience.consenting },
                { label: t("campaigns.reachable", { channel }), value: c.audience.reachable },
                { label: t("campaigns.recentlyMessaged"), value: c.audience.recentlyMessaged },
                {
                  label: t("campaigns.willReceive"),
                  value: <span data-testid="will-receive">{c.audience.willReceive}</span>,
                },
              ]}
            />
          </Card>
        ) : null}
        <Card title={t("campaigns.preview")}>
          {c.subject ? <p className="mb-2 font-medium">{c.subject}</p> : null}
          <pre
            className="bg-surface border-border rounded-lg border p-3 text-sm whitespace-pre-wrap"
            data-testid="campaign-preview"
          >
            {c.sample}
          </pre>
          {c.sms ? (
            <p className="text-muted mt-2 text-sm" data-testid="sms-parts">
              {t("campaigns.smsParts", {
                parts: c.sms.parts,
                length: c.sms.length,
                encoding: c.sms.encoding,
              })}
            </p>
          ) : null}
        </Card>
        {c.results ? (
          <Card title={t("campaigns.results")}>
            <DescriptionList
              items={[
                { label: t("campaigns.recipients"), value: c.results.total },
                { label: t("campaigns.sent"), value: c.results.sent },
                { label: t("campaigns.failed"), value: c.results.failed },
                { label: t("campaigns.skipped"), value: c.results.skipped },
                { label: t("campaigns.pending"), value: c.results.pending },
                { label: t("campaigns.optedOut"), value: c.results.optedOut },
                {
                  label: t("campaigns.returned", { days: c.attributionDays }),
                  value: `${c.results.returned}${c.results.returnRate ? ` (${c.results.returnRate.times(100).toFixed(0)}%)` : ""}`,
                },
                { label: t("campaigns.orders"), value: c.results.orders },
                {
                  label: t("campaigns.revenue"),
                  value: <span className="ltr-value">{fmt.money(c.results.revenue)}</span>,
                },
              ]}
            />
          </Card>
        ) : null}
        {c.canEdit ? (
          <Card title={t("campaigns.edit")}>
            <CampaignForm
              action={saveCampaignAction.bind(null, orgSlug, c.id)}
              segments={segments.segments.map((s) => ({ value: s.id, label: s.name }))}
              submitLabel={t("common.save")}
              defaults={{
                name: c.name,
                channel: c.channel,
                segmentId: c.segmentId,
                subject: c.subject ?? "",
                body: c.body,
                skipIfMessagedWithinDays: c.skipIfMessagedWithinDays?.toString() ?? "",
                attributionDays: String(c.attributionDays),
              }}
            />
          </Card>
        ) : null}
        {c.canLaunch ? (
          <Card title={t("campaigns.launch")}>
            <LaunchForm action={launchCampaignAction.bind(null, orgSlug, c.id)} />
          </Card>
        ) : null}
        {c.canCancel ? (
          <ConfirmActionButton
            action={cancelCampaignAction.bind(null, orgSlug, c.id)}
            label={t("campaigns.cancel")}
            variant="secondary"
          />
        ) : null}
      </div>
    </>
  );
}
