"use server";

import type { ActionState } from "@/components/forms/action-state";
import {
  archiveCoupon,
  archivePromotion,
  createCoupon,
  createPromotion,
} from "@/modules/pos/promotions";
import { formList, formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createPromotionAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createPromotion(ctx, {
      ...formValues(formData),
      categoryIds: formList(formData, "categoryIds"),
      itemIds: formList(formData, "itemIds"),
      channels: formList(formData, "channels"),
      weekdays: formList(formData, "weekdays"),
    });
  });
}

export async function archivePromotionAction(
  orgSlug: string,
  promotionId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => archivePromotion(ctx, promotionId));
}

export async function createCouponAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createCoupon(ctx, formValues(formData));
  });
}

export async function archiveCouponAction(
  orgSlug: string,
  couponId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => archiveCoupon(ctx, couponId));
}
