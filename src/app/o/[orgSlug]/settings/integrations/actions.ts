"use server";

import type { ActionState } from "@/components/forms/action-state";
import {
  createConnector,
  retryDelivery,
  rotateConnectorSecret,
  setConnectorStatus,
} from "@/modules/integrations/service";
import { formList, formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";
import { getEnv } from "@/server/env";

type S = ActionState;

const inboundUrl = (publicId: string) => `${getEnv().APP_URL}/api/integrations/inbound/${publicId}`;

// The secret travels back once in the action result; it is never stored in clear.
export async function createConnectorAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const values = formValues(formData);
    const c = await createConnector(ctx, {
      ...values,
      events: values.kind === "OUTBOUND_WEBHOOK" ? formList(formData, "events") : undefined,
    });
    return {
      data: {
        connectorId: c.id,
        secret: c.secret,
        ...(c.kind === "INBOUND_SALES_WEBHOOK" ? { endpoint: inboundUrl(c.publicId) } : {}),
      },
    };
  });
}

export async function rotateSecretAction(
  orgSlug: string,
  connectorId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const { secret } = await rotateConnectorSecret(ctx, connectorId);
    return { data: { secret } };
  });
}

export async function setConnectorStatusAction(
  orgSlug: string,
  connectorId: string,
  status: "ACTIVE" | "DISABLED",
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setConnectorStatus(ctx, connectorId, status),
  );
}

export async function retryDeliveryAction(
  orgSlug: string,
  deliveryId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => retryDelivery(ctx, deliveryId));
}
