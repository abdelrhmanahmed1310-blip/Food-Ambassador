"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms/action-state";
import { addStandardCost, saveSnapshot } from "@/modules/recipes/costs";
import {
  activateVersion,
  addIngredient,
  createDraftVersion,
  createRecipe,
  discardDraft,
  removeIngredient,
  setRecipeArchived,
  updateRecipe,
  updateVersion,
} from "@/modules/recipes/recipes";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createRecipeAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let target = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const created = await createRecipe(ctx, formValues(formData));
    target = `/o/${orgSlug}/recipes/${created!.id}/versions/${created!.versionId}`;
  });
  if (state.ok) redirect(target);
  return state;
}

export async function updateRecipeAction(
  orgSlug: string,
  recipeId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    updateRecipe(ctx, recipeId, formValues(formData)),
  );
}

export async function setRecipeArchivedAction(
  orgSlug: string,
  recipeId: string,
  archived: boolean,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setRecipeArchived(ctx, recipeId, archived),
  );
}

export async function createDraftVersionAction(
  orgSlug: string,
  recipeId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createDraftVersion(ctx, recipeId)).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/recipes/${recipeId}/versions/${id}`);
  return state;
}

export async function updateVersionAction(
  orgSlug: string,
  versionId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    updateVersion(ctx, versionId, formValues(formData)),
  );
}

export async function addIngredientAction(
  orgSlug: string,
  versionId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addIngredient(ctx, versionId, formValues(formData)),
  );
}

export async function removeIngredientAction(
  orgSlug: string,
  versionId: string,
  ingredientId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeIngredient(ctx, versionId, ingredientId),
  );
}

export async function activateVersionAction(
  orgSlug: string,
  versionId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await activateVersion(ctx, versionId);
  });
}

export async function discardDraftAction(
  orgSlug: string,
  versionId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let recipeId = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    recipeId = (await discardDraft(ctx, versionId)).recipeId;
  });
  if (state.ok) redirect(`/o/${orgSlug}/recipes/${recipeId}`);
  return state;
}

export async function saveSnapshotAction(
  orgSlug: string,
  versionId: string,
  query: { policy: string; warehouseId?: string },
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await saveSnapshot(ctx, versionId, query);
  });
}

export async function addStandardCostAction(
  orgSlug: string,
  productId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addStandardCost(ctx, productId, formValues(formData));
  });
}
