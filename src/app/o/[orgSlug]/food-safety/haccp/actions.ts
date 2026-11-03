"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addHaccpHazard,
  addHaccpStep,
  approveHaccpPlan,
  createHaccpPlan,
  linkHaccpCheckpoint,
  newHaccpPlanVersion,
  removeHaccpHazard,
  removeHaccpStep,
  saveHaccpControlPoint,
  unlinkHaccpCheckpoint,
} from "@/modules/foodsafety/haccp";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

const base = (orgSlug: string) => `/o/${orgSlug}/food-safety/haccp`;

export async function createPlanAction(orgSlug: string, previous: ActionState, formData: FormData) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createHaccpPlan(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`${base(orgSlug)}/${id}`);
  return state;
}

export async function addStepAction(
  orgSlug: string,
  planId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addHaccpStep(ctx, planId, formValues(formData));
  });
}

export async function removeStepAction(
  orgSlug: string,
  planId: string,
  stepId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => removeHaccpStep(ctx, planId, stepId));
}

export async function addHazardAction(
  orgSlug: string,
  planId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addHaccpHazard(ctx, planId, formValues(formData));
  });
}

export async function removeHazardAction(
  orgSlug: string,
  planId: string,
  hazardId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeHaccpHazard(ctx, planId, hazardId),
  );
}

export async function saveControlPointAction(
  orgSlug: string,
  planId: string,
  hazardId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await saveHaccpControlPoint(ctx, planId, hazardId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function linkCheckpointAction(
  orgSlug: string,
  planId: string,
  controlPointId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    linkHaccpCheckpoint(ctx, planId, controlPointId, formValues(formData)),
  );
}

export async function unlinkCheckpointAction(
  orgSlug: string,
  planId: string,
  controlPointId: string,
  checkpointId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    unlinkHaccpCheckpoint(ctx, planId, controlPointId, checkpointId),
  );
}

export async function approvePlanAction(
  orgSlug: string,
  planId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    approveHaccpPlan(ctx, planId, formValues(formData)),
  );
}

export async function newVersionAction(
  orgSlug: string,
  planId: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await newHaccpPlanVersion(ctx, planId)).id;
  });
  if (state.ok) redirect(`${base(orgSlug)}/${id}`);
  return state;
}
