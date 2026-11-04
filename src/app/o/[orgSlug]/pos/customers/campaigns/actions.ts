"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { cancelCampaign, launchCampaign, saveCampaign } from "@/modules/crm/campaigns";
import { zonedInstant } from "@/modules/pos/pickup-rules";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function saveCampaignAction(
  orgSlug: string,
  campaignId: string | null,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("common");
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await saveCampaign(ctx, formValues(formData), campaignId ?? undefined)).id;
    return { message: t("savedSuccessfully") };
  });
  if (id && !campaignId) redirect(`/o/${orgSlug}/pos/customers/campaigns/${id}`);
  return result;
}
export async function launchCampaignAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("common");
  const v = formValues(formData);
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    // datetime-local is wall time without a zone: read it in the organization's time zone.
    const at =
      v.scheduledAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v.scheduledAt)
        ? zonedInstant(
            v.scheduledAt.slice(0, 10),
            v.scheduledAt.slice(11, 16),
            ctx.timeZone,
          ).toISOString()
        : "";
    await launchCampaign(ctx, id, { scheduledAt: at });
    return { message: t("savedSuccessfully") };
  });
}
export async function cancelCampaignAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await cancelCampaign(ctx, id);
    return { message: t("savedSuccessfully") };
  });
}
