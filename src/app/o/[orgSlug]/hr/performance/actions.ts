"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  acknowledgeReview,
  addGoal,
  closeCycle,
  createCycle,
  finalizeReview,
  launchCycle,
  skipReview,
  submitManagerReview,
  submitSelfReview,
  updateGoal,
} from "@/modules/performance/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;
const saved = async () => ({ message: (await getTranslations("common"))("savedSuccessfully") });

export async function createCycleAction(orgSlug: string, previous: S, formData: FormData) {
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createCycle(ctx, formValues(formData))).id;
  });
  if (id) redirect(`/o/${orgSlug}/hr/performance/${id}`);
  return result;
}
export async function launchCycleAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    launchCycle(ctx, id).then(() => undefined),
  );
}
export async function closeCycleAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => closeCycle(ctx, id));
}
export async function addGoalAction(
  orgSlug: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addGoal(ctx, employeeId, formValues(formData));
    return saved();
  });
}
export async function updateGoalAction(
  orgSlug: string,
  goalId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateGoal(ctx, goalId, formValues(formData));
    return saved();
  });
}
export async function selfReviewAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    submitSelfReview(ctx, id, formValues(formData)),
  );
}
export async function managerReviewAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    submitManagerReview(ctx, id, formValues(formData)),
  );
}
export async function acknowledgeAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    acknowledgeReview(ctx, id, formValues(formData)),
  );
}
export async function finalizeAction(orgSlug: string, id: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    finalizeReview(ctx, id, formValues(formData)),
  );
}
export async function skipAction(orgSlug: string, id: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    skipReview(ctx, id, formValues(formData)),
  );
}
