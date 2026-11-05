"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addQuestion,
  closeSurvey,
  createSurvey,
  giveRecognition,
  hideRecognition,
  openSurvey,
  removeQuestion,
  submitSurvey,
} from "@/modules/engagement/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createSurveyAction(orgSlug: string, previous: S, formData: FormData) {
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createSurvey(ctx, formValues(formData))).id;
  });
  if (id) redirect(`/o/${orgSlug}/hr/engagement/${id}`);
  return result;
}
export async function addQuestionAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addQuestion(ctx, id, formValues(formData)),
  );
}
export async function removeQuestionAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => removeQuestion(ctx, id));
}
export async function openSurveyAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    openSurvey(ctx, id).then(() => undefined),
  );
}
export async function closeSurveyAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => closeSurvey(ctx, id));
}
export async function submitSurveyAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  const result = await tenantMutation(orgSlug, previous, formData, (ctx) =>
    submitSurvey(ctx, id, formValues(formData)),
  );
  if (result.ok) redirect(`/o/${orgSlug}/my/surveys?thanks=1`);
  return result;
}
export async function recognizeAction(orgSlug: string, previous: S, formData: FormData) {
  const t = await getTranslations("engagement");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await giveRecognition(ctx, formValues(formData));
    return { message: t("sent") };
  });
}
export async function hideRecognitionAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    hideRecognition(ctx, id, formValues(formData)),
  );
}
