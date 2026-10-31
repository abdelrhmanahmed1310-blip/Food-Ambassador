"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  cancelProductionOrder,
  completeProduction,
  createProductionOrder,
  reverseProduction,
  setRecipeOutputProduct,
} from "@/modules/production/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createProductionOrderAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createProductionOrder(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/production/${id}`);
  return state;
}

export async function completeProductionAction(
  orgSlug: string,
  orderId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await completeProduction(ctx, orderId, formValues(formData));
  });
}

export async function cancelProductionAction(
  orgSlug: string,
  orderId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelProductionOrder(ctx, orderId, formValues(formData)),
  );
}

export async function reverseProductionAction(
  orgSlug: string,
  orderId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    reverseProduction(ctx, orderId, formValues(formData)),
  );
}

export async function setOutputProductAction(
  orgSlug: string,
  recipeId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setRecipeOutputProduct(ctx, recipeId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}
