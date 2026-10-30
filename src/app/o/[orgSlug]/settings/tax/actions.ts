"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addTaxRate,
  applyCountryPreset,
  createTaxCode,
  updateTaxSettings,
} from "@/modules/tax/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function applyPresetAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("tax");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await applyCountryPreset(ctx, String(formData.get("country") ?? ""));
    return { message: r.vatInForce ? t("presetApplied") : t("presetNoVat") };
  });
}

export async function updateTaxSettingsAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateTaxSettings(ctx, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function createTaxCodeAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createTaxCode(ctx, formValues(formData));
  });
}

export async function addTaxRateAction(
  orgSlug: string,
  taxCodeId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addTaxRate(ctx, taxCodeId, formValues(formData)),
  );
}
