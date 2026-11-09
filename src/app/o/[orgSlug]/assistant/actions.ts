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

/** Where each helper lives: the business assistant (ADR-122) and the food consultant (ADR-131). */
const PAGE = { BUSINESS: "assistant", CONSULTANT: "consultant" } as const;
type Mode = keyof typeof PAGE;

export async function askAction(
  orgSlug: string,
  mode: Mode,
  conversationId: string | null,
  previous: S,
  formData: FormData,
) {
  const locale = (await getLocale()) === "ar" ? "ar" : "en";
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await askAssistant(
      ctx,
      {
        conversationId: conversationId ?? undefined,
        question: formValues(formData).question,
        mode,
      },
      { locale },
    );
    id = r.conversationId;
  });
  if (id && !conversationId) redirect(`/o/${orgSlug}/${PAGE[mode]}?c=${id}`);
  return result;
}

export async function deleteConversationAction(
  orgSlug: string,
  mode: Mode,
  id: string,
  previous: S,
  formData: FormData,
) {
  const result = await tenantMutation(orgSlug, previous, formData, (ctx) =>
    deleteConversation(ctx, id),
  );
  if (result.ok) redirect(`/o/${orgSlug}/${PAGE[mode]}`);
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
