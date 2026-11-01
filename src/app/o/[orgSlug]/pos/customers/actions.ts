"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms/action-state";
import {
  adjustPoints,
  createCustomer,
  eraseCustomer,
  saveLoyaltySettings,
  updateCustomer,
} from "@/modules/pos/customers";
import { blockGiftCard } from "@/modules/pos/gift-cards";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createCustomerAction(orgSlug: string, previous: S, formData: FormData) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createCustomer(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/pos/customers/${id}`);
  return state;
}

export async function updateCustomerAction(
  orgSlug: string,
  customerId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    updateCustomer(ctx, customerId, formValues(formData)),
  );
}

export async function adjustPointsAction(
  orgSlug: string,
  customerId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    adjustPoints(ctx, customerId, formValues(formData)),
  );
}

export async function eraseCustomerAction(
  orgSlug: string,
  customerId: string,
  previous: S,
  formData: FormData,
) {
  const state = await tenantMutation(orgSlug, previous, formData, (ctx) =>
    eraseCustomer(ctx, customerId),
  );
  if (state.ok) redirect(`/o/${orgSlug}/pos/customers`);
  return state;
}

export async function loyaltySettingsAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    saveLoyaltySettings(ctx, formValues(formData)),
  );
}

export async function blockGiftCardAction(
  orgSlug: string,
  giftCardId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => blockGiftCard(ctx, giftCardId));
}
