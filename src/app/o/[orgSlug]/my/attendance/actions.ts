"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { clockFromPhone } from "@/modules/hr/attendance";
import { runFormAction } from "@/server/actions/handle";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** Clock in or out from the employee's own phone. */
export async function phoneClockAction(
  orgSlug: string,
  input: { latitude?: number; longitude?: number },
): Promise<ActionState> {
  const ctx = await requireTenant(orgSlug);
  const t = await getTranslations("attendance");
  const state = await runFormAction({}, new FormData(), async () => {
    const r = await clockFromPhone(ctx, input);
    return { message: r.kind === "IN" ? t("clockedInNow") : t("clockedOutNow") };
  });
  if (state.ok) revalidatePath(`/o/${orgSlug}/my/attendance`);
  return state;
}
