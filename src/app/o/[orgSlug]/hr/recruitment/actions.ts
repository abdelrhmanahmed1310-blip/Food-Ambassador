"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addApplication,
  cancelInterview,
  closeOpening,
  createCandidate,
  decideOpening,
  eraseCandidate,
  hireCandidate,
  moveApplication,
  requestOpening,
  scheduleInterview,
  setPosition,
  setRecruitmentSettings,
  submitScorecard,
} from "@/modules/recruitment/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function setPositionAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setPosition(ctx, formValues(formData)),
  );
}
export async function saveRetentionAction(orgSlug: string, previous: S, formData: FormData) {
  const t = await getTranslations("recruitment");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setRecruitmentSettings(ctx, formValues(formData));
    return { message: t("saved") };
  });
}
export async function requestOpeningAction(orgSlug: string, previous: S, formData: FormData) {
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await requestOpening(ctx, formValues(formData))).id;
  });
  if (id) redirect(`/o/${orgSlug}/hr/recruitment/openings/${id}`);
  return result;
}
export async function decideOpeningAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    decideOpening(ctx, id, formValues(formData)),
  );
}
export async function closeOpeningAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    closeOpening(ctx, id, formValues(formData)),
  );
}
export async function addApplicationAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addApplication(ctx, id, formValues(formData));
  });
}
export async function createCandidateAction(orgSlug: string, previous: S, formData: FormData) {
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createCandidate(ctx, formValues(formData))).id;
  });
  if (id) redirect(`/o/${orgSlug}/hr/recruitment/candidates/${id}`);
  return result;
}
export async function eraseCandidateAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => eraseCandidate(ctx, id));
}
export async function moveApplicationAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    moveApplication(ctx, id, formValues(formData)),
  );
}
export async function scheduleInterviewAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await scheduleInterview(ctx, id, formValues(formData));
  });
}
export async function cancelInterviewAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await cancelInterview(ctx, id);
  });
}
export async function submitScorecardAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    submitScorecard(ctx, id, formValues(formData)),
  );
}
export async function hireAction(orgSlug: string, id: string, previous: S, formData: FormData) {
  let employeeId: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    employeeId = (await hireCandidate(ctx, id, formValues(formData))).employeeId;
  });
  if (employeeId) redirect(`/o/${orgSlug}/hr/employees/${employeeId}`);
  return result;
}
