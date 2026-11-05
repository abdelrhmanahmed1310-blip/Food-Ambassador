"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addShift,
  cancelShift,
  copyWeek,
  createShiftTemplate,
  decideOvertime,
  publishWeek,
  removeShift,
  setRosterSettings,
  setShiftTemplateArchived,
} from "@/modules/rosters/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function saveRosterSettingsAction(orgSlug: string, previous: S, formData: FormData) {
  const t = await getTranslations("rosters");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setRosterSettings(ctx, formValues(formData));
    return { message: t("saved") };
  });
}
export async function createShiftTemplateAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createShiftTemplate(ctx, formValues(formData));
  });
}
export async function archiveShiftTemplateAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setShiftTemplateArchived(ctx, id, true),
  );
}
export async function addShiftAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addShift(ctx, formValues(formData));
  });
}
export async function publishWeekAction(
  orgSlug: string,
  branchId: string,
  week: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("rosters");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const { count } = await publishWeek(ctx, { branchId, week });
    return { message: t("published", { count }) };
  });
}
export async function copyWeekAction(
  orgSlug: string,
  branchId: string,
  week: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("rosters");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await copyWeek(ctx, { branchId, week, fromWeek: formData.get("fromWeek") });
    return { message: t("copied", r) };
  });
}
export async function removeShiftAction(
  orgSlug: string,
  id: string,
  back: string,
  previous: S,
  formData: FormData,
) {
  const result = await tenantMutation(orgSlug, previous, formData, (ctx) => removeShift(ctx, id));
  if (result.ok) redirect(back);
  return result;
}
export async function cancelShiftAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await cancelShift(ctx, id, formValues(formData));
  });
}
export async function decideOvertimeAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await decideOvertime(ctx, id, formValues(formData));
  });
}
