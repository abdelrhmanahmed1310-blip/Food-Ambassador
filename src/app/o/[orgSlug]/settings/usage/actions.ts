"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { saveUsageLimits } from "@/modules/usage/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

/** The organization's usage limits (ADR-146). */
export async function saveUsageLimitsAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await saveUsageLimits(ctx, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}
