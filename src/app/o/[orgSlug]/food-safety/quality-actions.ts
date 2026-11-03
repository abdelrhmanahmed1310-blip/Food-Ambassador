"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms/action-state";
import {
  addAuditFinding,
  cancelAudit,
  completeAudit,
  investigateComplaint,
  logComplaint,
  planAudit,
  raiseComplaintNonConformance,
  resolveComplaint,
} from "@/modules/foodsafety/quality";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function planAuditAction(orgSlug: string, previous: ActionState, formData: FormData) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await planAudit(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/food-safety/audits/${id}`);
  return state;
}

export async function addFindingAction(
  orgSlug: string,
  auditId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addAuditFinding(ctx, auditId, formValues(formData));
  });
}

export async function completeAuditAction(
  orgSlug: string,
  auditId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    completeAudit(ctx, auditId, formValues(formData)),
  );
}

export async function cancelAuditAction(
  orgSlug: string,
  auditId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelAudit(ctx, auditId, formValues(formData)),
  );
}

export async function logComplaintAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await logComplaint(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/food-safety/complaints/${id}`);
  return state;
}

export async function investigateComplaintAction(
  orgSlug: string,
  complaintId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    investigateComplaint(ctx, complaintId, formValues(formData)),
  );
}

export async function resolveComplaintAction(
  orgSlug: string,
  complaintId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    resolveComplaint(ctx, complaintId, formValues(formData)),
  );
}

export async function raiseComplaintNcAction(
  orgSlug: string,
  complaintId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await raiseComplaintNonConformance(ctx, complaintId);
  });
}
