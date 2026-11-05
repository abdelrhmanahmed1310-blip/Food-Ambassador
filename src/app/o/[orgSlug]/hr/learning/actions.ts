"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addExternalRecord,
  addParticipants,
  addRequirement,
  cancelSession,
  completeSession,
  createCourse,
  recordAttendance,
  removeRequirement,
  scheduleSession,
  setCourseArchived,
  voidRecord,
} from "@/modules/learning/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;
const saved = async () => ({ message: (await getTranslations("common"))("savedSuccessfully") });

export async function createCourseAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createCourse(ctx, formValues(formData));
    return saved();
  });
}
export async function archiveCourseAction(
  orgSlug: string,
  id: string,
  archived: boolean,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => setCourseArchived(ctx, id, archived));
}
export async function addRequirementAction(
  orgSlug: string,
  courseId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addRequirement(ctx, { ...formValues(formData), courseId });
    return saved();
  });
}
export async function removeRequirementAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => removeRequirement(ctx, id));
}
export async function scheduleSessionAction(orgSlug: string, previous: S, formData: FormData) {
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await scheduleSession(ctx, formValues(formData))).id;
  });
  if (id) redirect(`/o/${orgSlug}/hr/learning/sessions/${id}`);
  return result;
}
export async function addParticipantsAction(
  orgSlug: string,
  sessionId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addParticipants(
      ctx,
      sessionId,
      formData.getAll("employeeId").filter((v): v is string => typeof v === "string"),
    ),
  );
}
export async function attendanceAction(
  orgSlug: string,
  sessionId: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    recordAttendance(ctx, sessionId, employeeId, formValues(formData)),
  );
}
export async function completeSessionAction(
  orgSlug: string,
  sessionId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("learning");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await completeSession(ctx, sessionId);
    return { message: t("completed", { count: r.passed }) };
  });
}
export async function cancelSessionAction(
  orgSlug: string,
  sessionId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelSession(ctx, sessionId, formValues(formData)),
  );
}
export async function addRecordAction(
  orgSlug: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addExternalRecord(ctx, employeeId, formValues(formData));
    return saved();
  });
}
export async function voidRecordAction(
  orgSlug: string,
  recordId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    voidRecord(ctx, recordId, formValues(formData)),
  );
}
