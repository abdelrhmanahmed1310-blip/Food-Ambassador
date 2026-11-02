"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms/action-state";
import { cancelRevaluation, postRevaluation } from "@/modules/invoices/revaluation";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function postRevaluationAction(
  orgSlug: string,
  asOf: string,
  companyId: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await postRevaluation(ctx, { ...formValues(formData), asOf, companyId })).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/purchasing/payables/revaluation/${id}`);
  return state;
}

export async function cancelRevaluationAction(
  orgSlug: string,
  revaluationId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelRevaluation(ctx, revaluationId, formValues(formData)),
  );
}
