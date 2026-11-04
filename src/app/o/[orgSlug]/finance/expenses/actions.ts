"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms/action-state";
import {
  createCostCentre,
  createExpenseCategory,
  recordExpense,
  reverseExpense,
  setSetupArchived,
} from "@/modules/finance/expenses";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function recordExpenseAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await recordExpense(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/finance/expenses/${id}`);
  return state;
}

export async function reverseExpenseAction(
  orgSlug: string,
  expenseId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    reverseExpense(ctx, expenseId, formValues(formData)),
  );
}

export async function createCategoryAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createExpenseCategory(ctx, formValues(formData));
  });
}

export async function createCentreAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createCostCentre(ctx, formValues(formData));
  });
}

export async function archiveSetupAction(
  orgSlug: string,
  kind: "COST_CENTRE" | "CATEGORY",
  id: string,
  archived: boolean,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setSetupArchived(ctx, kind, id, archived),
  );
}
