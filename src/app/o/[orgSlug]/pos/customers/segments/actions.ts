"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { escalateFeedback, reviewFeedback } from "@/modules/crm/feedback";
import { archiveSegment, saveSegment } from "@/modules/crm/segments";
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

export async function saveSegmentAction(orgSlug: string, previous: S, formData: FormData) {
  const v = formValues(formData);
  const { name, description, ...rules } = v;
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (
      await saveSegment(ctx, {
        name,
        description,
        rules: { ...rules, branchIds: formData.getAll("branchIds").map(String) },
      })
    ).id;
  });
  if (id) redirect(`/o/${orgSlug}/pos/customers/segments/${id}`);
  return result;
}
export async function archiveSegmentAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  const result = await saved(orgSlug, previous, formData, (ctx) => archiveSegment(ctx, id));
  if (result.ok) redirect(`/o/${orgSlug}/pos/customers/segments`);
  return result;
}
export async function reviewFeedbackAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => reviewFeedback(ctx, id, formValues(formData)));
}
export async function escalateFeedbackAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    escalateFeedback(ctx, id, formValues(formData)),
  );
}
