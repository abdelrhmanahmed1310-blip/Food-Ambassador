"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  assignRider,
  cancelHomeDelivery,
  createHomeDelivery,
  markDelivered,
  markFailed,
  pickUp,
} from "@/modules/delivery/home";
import type { TenantContext } from "@/modules/tenancy/context";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

async function saved(
  orgSlug: string,
  previous: S,
  formData: FormData,
  run: (ctx: TenantContext) => Promise<unknown>,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await run(ctx);
    return { message: t("savedSuccessfully") };
  });
}

export async function createHomeDeliveryAction(
  orgSlug: string,
  posOrderId: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    createHomeDelivery(ctx, { ...formValues(formData), posOrderId }),
  );
}
export async function assignRiderAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => assignRider(ctx, id, formValues(formData)));
}
export async function pickUpAction(orgSlug: string, id: string, previous: S, formData: FormData) {
  return saved(orgSlug, previous, formData, (ctx) => pickUp(ctx, id));
}
export async function deliveredAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => markDelivered(ctx, id, formValues(formData)));
}
export async function failedAction(orgSlug: string, id: string, previous: S, formData: FormData) {
  return saved(orgSlug, previous, formData, (ctx) => markFailed(ctx, id, formValues(formData)));
}
export async function cancelDeliveryAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    cancelHomeDelivery(ctx, id, formValues(formData)),
  );
}
