"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms/action-state";
import {
  addTemplateTask,
  cancelOnboarding,
  createOnboardingTemplate,
  removeTemplateTask,
  setOnboardingTask,
  setOnboardingTemplateArchived,
  startOnboarding,
} from "@/modules/rosters/onboarding";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createOnboardingTemplateAction(
  orgSlug: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createOnboardingTemplate(ctx, formValues(formData));
  });
}
export async function addTemplateTaskAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addTemplateTask(ctx, id, formValues(formData)),
  );
}
export async function removeTemplateTaskAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await removeTemplateTask(ctx, id);
  });
}
export async function archiveOnboardingTemplateAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setOnboardingTemplateArchived(ctx, id, true),
  );
}
export async function startOnboardingAction(
  orgSlug: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await startOnboarding(ctx, employeeId, formValues(formData))).id;
  });
  if (id) redirect(`/o/${orgSlug}/hr/onboarding/${id}`);
  return result;
}
export async function tickTaskAction(
  orgSlug: string,
  id: string,
  done: boolean,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setOnboardingTask(ctx, id, { done, note: formData.get("note") ?? "" });
  });
}
export async function cancelChecklistAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelOnboarding(ctx, id, formValues(formData)),
  );
}
