"use server";

import type { ActionState } from "@/components/forms/action-state";
import { createApiClient, revokeApiClient } from "@/modules/api/clients";
import { formList, formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createApiKeyAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const c = await createApiClient(ctx, {
      ...formValues(formData),
      scopes: formList(formData, "scopes"),
    });
    // Returned once to the page that created it; never stored in clear.
    return { data: { key: c.key } };
  });
}

export async function revokeApiKeyAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await revokeApiClient(ctx, id);
  });
}
