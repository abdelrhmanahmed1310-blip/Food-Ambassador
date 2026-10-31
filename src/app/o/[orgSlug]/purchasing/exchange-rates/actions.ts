"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { importExchangeRates, setExchangeRate } from "@/modules/fx/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function setExchangeRateAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setExchangeRate(ctx, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function importExchangeRatesAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("fx");
  const text = String(formData.get("csv") ?? "");
  if (text.length > 200_000)
    return { ok: false, seq: (previous.seq ?? 0) + 1, formError: t("csvTooLarge") };
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await importExchangeRates(ctx, text);
    if (!r.ok)
      return {
        ok: false,
        formError: t("importFailed"),
        data: { errors: JSON.stringify(r.errors) },
      };
    return { message: t("imported", { count: r.imported }) };
  });
}
