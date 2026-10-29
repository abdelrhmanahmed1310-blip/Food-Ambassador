"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { createBranch, setBranchArchived, updateBranch } from "@/modules/sites/branches";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createBranchAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createBranch(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/branches/${id}`);
  return state;
}

export async function updateBranchAction(
  orgSlug: string,
  branchId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateBranch(ctx, branchId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function setBranchArchivedAction(
  orgSlug: string,
  branchId: string,
  archived: boolean,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setBranchArchived(ctx, branchId, archived),
  );
}
