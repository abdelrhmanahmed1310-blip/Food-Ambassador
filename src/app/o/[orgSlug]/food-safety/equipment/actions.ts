"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  createEquipment,
  recordCalibration,
  recordMaintenance,
  retireEquipment,
  returnEquipmentToService,
  setEquipmentOutOfService,
} from "@/modules/foodsafety/equipment";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createEquipmentAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createEquipment(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/food-safety/equipment/${id}`);
  return state;
}

export async function calibrateAction(
  orgSlug: string,
  equipmentId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("equipment");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await recordCalibration(ctx, equipmentId, formValues(formData));
    return {
      message:
        r.result === "PASS" ? t("passed") : t("failed", { number: r.nonConformance?.number ?? "" }),
    };
  });
}

export async function maintainAction(
  orgSlug: string,
  equipmentId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await recordMaintenance(ctx, equipmentId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function outOfServiceAction(
  orgSlug: string,
  equipmentId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setEquipmentOutOfService(ctx, equipmentId, formValues(formData)),
  );
}

export async function returnToServiceAction(
  orgSlug: string,
  equipmentId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    returnEquipmentToService(ctx, equipmentId),
  );
}

export async function retireAction(
  orgSlug: string,
  equipmentId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    retireEquipment(ctx, equipmentId, formValues(formData)),
  );
}
