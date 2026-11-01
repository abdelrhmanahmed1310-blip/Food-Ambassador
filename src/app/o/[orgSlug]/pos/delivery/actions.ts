"use server";

import type { ActionState } from "@/components/forms/action-state";
import {
  acceptDeliveryOrder,
  createDeliveryConnector,
  rejectDeliveryOrder,
  removeDeliveryMap,
  setDeliveryMap,
} from "@/modules/delivery/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";
import { getEnv } from "@/server/env";

type S = ActionState;

// The secret travels back once in the action result; it is never stored in clear.
export async function createDeliveryConnectorAction(
  orgSlug: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const c = await createDeliveryConnector(ctx, formValues(formData));
    return {
      data: {
        connectorId: c.id,
        secret: c.secret,
        endpoint: `${getEnv().APP_URL}/api/integrations/inbound/${c.publicId}`,
      },
    };
  });
}

export async function setMapAction(
  orgSlug: string,
  connectorId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setDeliveryMap(ctx, connectorId, formValues(formData));
  });
}

export async function removeMapAction(
  orgSlug: string,
  mapId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => removeDeliveryMap(ctx, mapId));
}

export async function acceptAction(orgSlug: string, id: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await acceptDeliveryOrder(ctx, id);
  });
}

export async function rejectAction(orgSlug: string, id: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    rejectDeliveryOrder(ctx, id, formValues(formData)),
  );
}
