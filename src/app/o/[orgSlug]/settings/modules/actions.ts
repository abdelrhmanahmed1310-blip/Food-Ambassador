"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { saveFeatureSettings } from "@/modules/features/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";
import { AppError } from "@/server/errors";

/** Save Settings → Modules (ADR-137); a missing dependency is explained by name. */
export async function saveModulesAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("features");
  return tenantMutation(orgSlug, previous, formData, async (ctx): Promise<Partial<ActionState>> => {
    try {
      const r = await saveFeatureSettings(ctx, formValues(formData));
      return {
        message: r.switchedOff.length + r.switchedOn.length === 0 ? t("unchanged") : t("saved"),
      };
    } catch (error) {
      if (error instanceof AppError && typeof error.details?.pairs === "string") {
        const name = (key: string) => t(`functions.${key}` as "functions.pos.till");
        const lines = error.details.pairs
          .split(",")
          .map((p) => p.split(">"))
          .map(([f, r]) => t("pairProblem", { name: name(f), needs: name(r) }));
        return { ok: false, formError: [t("dependencyProblem"), ...lines].join(" ") };
      }
      throw error;
    }
  });
}
