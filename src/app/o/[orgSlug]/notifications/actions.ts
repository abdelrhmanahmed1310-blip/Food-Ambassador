"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  markAllNotificationsRead,
  saveNotificationPreferences,
} from "@/modules/notifications/service";
import { formList } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function markAllReadAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await markAllNotificationsRead(ctx);
  });
}

export async function savePreferencesAction(orgSlug: string, previous: S, formData: FormData) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await saveNotificationPreferences(ctx, { on: formList(formData, "on") });
    return { message: t("savedSuccessfully") };
  });
}
