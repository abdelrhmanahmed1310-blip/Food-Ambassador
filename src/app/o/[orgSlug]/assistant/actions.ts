"use server";

import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  askAssistant,
  deleteConversation,
  setAssistantEnabled,
  testAssistantConnection,
  updateAssistantSettings,
} from "@/modules/assistant/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function askAction(
  orgSlug: string,
  conversationId: string | null,
  previous: S,
  formData: FormData,
) {
  const locale = (await getLocale()) === "ar" ? "ar" : "en";
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await askAssistant(
      ctx,
      { conversationId: conversationId ?? undefined, question: formValues(formData).question },
      { locale },
    );
    id = r.conversationId;
  });
  if (id && !conversationId) redirect(`/o/${orgSlug}/assistant?c=${id}`);
  return result;
}

export async function deleteConversationAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  const result = await tenantMutation(orgSlug, previous, formData, (ctx) =>
    deleteConversation(ctx, id),
  );
  if (result.ok) redirect(`/o/${orgSlug}/assistant`);
  return result;
}

export async function saveAssistantSettingsAction(
  orgSlug: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateAssistantSettings(ctx, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function testAssistantAction(orgSlug: string, previous: S, formData: FormData) {
  const t = await getTranslations("assistant");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await testAssistantConnection(ctx);
    return { message: r.ok ? t("testPassed") : t("testFailed", { error: r.error ?? "" }) };
  });
}

export async function setAssistantEnabledAction(
  orgSlug: string,
  enabled: boolean,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setAssistantEnabled(ctx, enabled);
    return { message: t("savedSuccessfully") };
  });
}
