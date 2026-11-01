"use server";

import type { ActionState } from "@/components/forms/action-state";
import {
  acceptGuestOrder,
  archiveOrderingChannel,
  createOrderingChannel,
  rejectGuestOrder,
} from "@/modules/pos/ordering";
import { formList, formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createChannelAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createOrderingChannel(ctx, {
      ...formValues(formData),
      channels: formList(formData, "channels"),
    });
  });
}

export async function archiveChannelAction(
  orgSlug: string,
  channelId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    archiveOrderingChannel(ctx, channelId),
  );
}

export async function acceptGuestAction(
  orgSlug: string,
  tabId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await acceptGuestOrder(ctx, tabId);
  });
}

export async function rejectGuestAction(
  orgSlug: string,
  tabId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    rejectGuestOrder(ctx, tabId, formValues(formData)),
  );
}
