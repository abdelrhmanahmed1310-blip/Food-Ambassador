"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  onboardDevice,
  prepareDevice,
  prepareOfficeUnit,
  reportNow,
  updateZatcaSettings,
} from "@/modules/zatca/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function updateZatcaSettingsAction(
  orgSlug: string,
  companyId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateZatcaSettings(ctx, { ...formValues(formData), companyId });
    return { message: t("savedSuccessfully") };
  });
}

export async function prepareDeviceAction(
  orgSlug: string,
  registerId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await prepareDevice(ctx, registerId);
  });
}

export async function onboardDeviceAction(
  orgSlug: string,
  deviceId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await onboardDevice(ctx, deviceId, formValues(formData));
  });
}

export async function reportNowAction(orgSlug: string, previous: S, formData: FormData) {
  const t = await getTranslations("zatca");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await reportNow(ctx);
    const count = (s: string) => r.filter((x) => x.status === s).length;
    return {
      message: t("reportResult", {
        reported: count("REPORTED") + count("REPORTED_WITH_WARNINGS"),
        rejected: count("REJECTED"),
        retrying: count("PENDING"),
      }),
    };
  });
}

/** A company's back-office unit for standard (B2B) invoices (ADR-072, ADR-085). */
export async function prepareOfficeUnitAction(
  orgSlug: string,
  companyId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await prepareOfficeUnit(ctx, companyId);
  });
}
