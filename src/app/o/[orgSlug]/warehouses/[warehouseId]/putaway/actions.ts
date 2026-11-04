"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { archivePutawayRule, createPutawayRule, putAway } from "@/modules/wms/putaway";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function putAwayAction(
  orgSlug: string,
  balanceId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("putaway");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await putAway(ctx, { ...formValues(formData), balanceId });
    return { message: t("done", { number: r.number }) };
  });
}

export async function createRuleAction(
  orgSlug: string,
  warehouseId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createPutawayRule(ctx, warehouseId, formValues(formData));
  });
}

export async function archiveRuleAction(
  orgSlug: string,
  ruleId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => archivePutawayRule(ctx, ruleId));
}
