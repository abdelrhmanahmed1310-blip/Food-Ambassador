import "server-only";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/forms/action-state";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import type { TenantContext } from "@/modules/tenancy/context";
import { runFormAction } from "./handle";

/**
 * Standard tenant form action: resolve the TenantContext from the session and
 * the org slug (never from form fields), run the mutation, refresh the tenant's
 * pages. Callers redirect afterwards when `ok`.
 */
export async function tenantMutation(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
  fn: (ctx: TenantContext) => Promise<Partial<ActionState> | void>,
): Promise<ActionState> {
  const ctx = await requireTenant(orgSlug);
  const state = await runFormAction(previous, formData, () => fn(ctx));
  if (state.ok) revalidatePath(`/o/${orgSlug}`, "layout");
  return state;
}
