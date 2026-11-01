"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { savePaymentProvider } from "@/modules/payments/links";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function savePaymentProviderAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await savePaymentProvider(ctx, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}
