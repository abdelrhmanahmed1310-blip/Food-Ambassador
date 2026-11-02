"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addCommonLeaveTypes,
  cancelLeave,
  createLeaveType,
  decideLeave,
  requestLeave,
  setLeaveAllocation,
  setLeaveTypeArchived,
} from "@/modules/hr/leave";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function requestLeaveAction(
  orgSlug: string,
  employeeId: string | null,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("leave");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await requestLeave(ctx, employeeId, formValues(formData));
    return { message: t("requested") };
  });
}

export async function decideLeaveAction(
  orgSlug: string,
  requestId: string,
  decision: "APPROVED" | "REJECTED",
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    decideLeave(ctx, requestId, { ...formValues(formData), decision }),
  );
}

export async function cancelLeaveAction(
  orgSlug: string,
  requestId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => cancelLeave(ctx, requestId));
}

export async function setAllocationAction(
  orgSlug: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("leave");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setLeaveAllocation(ctx, employeeId, formValues(formData));
    return { message: t("entitlementSet") };
  });
}

export async function createLeaveTypeAction(orgSlug: string, previous: S, formData: FormData) {
  const t = await getTranslations("leave");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createLeaveType(ctx, formValues(formData));
    return { message: t("typeAdded") };
  });
}

export async function addCommonTypesAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addCommonLeaveTypes(ctx);
  });
}

export async function archiveLeaveTypeAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => setLeaveTypeArchived(ctx, id, true));
}
