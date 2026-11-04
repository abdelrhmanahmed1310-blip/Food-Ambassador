"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  cancelMockRecall,
  completeMockRecall,
  startMockRecall,
} from "@/modules/traceability/mock-recalls";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function startMockRecallAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await startMockRecall(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/traceability/mock-recalls/${id}`);
  return state;
}

/** "counts.<i>.<field>" keys → { counts: [...] }. */
function completeInput(values: Record<string, string>) {
  const counts: Array<Record<string, string>> = [];
  const header: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const m = /^counts\.(\d{1,3})\.([A-Za-z]+)$/.exec(key);
    if (m) (counts[Number(m[1])] ??= {})[m[2]] = value;
    else header[key] = value;
  }
  return { ...header, counts: counts.filter(Boolean) };
}

export async function completeMockRecallAction(
  orgSlug: string,
  id: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("mockRecalls");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await completeMockRecall(ctx, id, completeInput(formValues(formData)));
    return {
      message: r.nonConformance
        ? t("ncMessage", { number: r.nonConformance.number })
        : t("completedMessage"),
    };
  });
}

export async function cancelMockRecallAction(
  orgSlug: string,
  id: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelMockRecall(ctx, id, formValues(formData)),
  );
}
