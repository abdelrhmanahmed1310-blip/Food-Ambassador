"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addRfqLine,
  awardRfq,
  cancelRfq,
  createRfq,
  inviteRfqSupplier,
  recordQuotation,
  removeRfqLine,
  removeRfqSupplier,
  sendRfq,
  updateRfqHeader,
} from "@/modules/procurement/rfqs";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

/** `lines.<i>.<field>` form fields as an array (ADR-092 forms). */
function withLines(values: Record<string, string>) {
  const lines: Array<Record<string, string>> = [];
  const header: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const m = /^lines\.(\d{1,3})\.([A-Za-z]+)$/.exec(key);
    if (m) (lines[Number(m[1])] ??= {})[m[2]] = value;
    else header[key] = value;
  }
  return { ...header, lines: lines.filter(Boolean) };
}

export async function createRfqAction(orgSlug: string, previous: ActionState, formData: FormData) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createRfq(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/purchasing/rfqs/${id}`);
  return state;
}

export async function updateRfqAction(
  orgSlug: string,
  rfqId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateRfqHeader(ctx, rfqId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function addRfqLineAction(
  orgSlug: string,
  rfqId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addRfqLine(ctx, rfqId, formValues(formData));
  });
}

export async function removeRfqLineAction(
  orgSlug: string,
  rfqId: string,
  lineId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => removeRfqLine(ctx, rfqId, lineId));
}

export async function inviteRfqSupplierAction(
  orgSlug: string,
  rfqId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    inviteRfqSupplier(ctx, rfqId, formValues(formData)),
  );
}

export async function removeRfqSupplierAction(
  orgSlug: string,
  rfqId: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeRfqSupplier(ctx, rfqId, supplierId),
  );
}

export async function sendRfqAction(
  orgSlug: string,
  rfqId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => sendRfq(ctx, rfqId));
}

export async function cancelRfqAction(
  orgSlug: string,
  rfqId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelRfq(ctx, rfqId, formValues(formData)),
  );
}

export async function recordQuotationAction(
  orgSlug: string,
  rfqId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await recordQuotation(ctx, rfqId, withLines(formValues(formData)));
    return { message: t("savedSuccessfully") };
  });
}

export async function awardRfqAction(
  orgSlug: string,
  rfqId: string,
  previous: ActionState,
  formData: FormData,
) {
  let first = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const { orders } = await awardRfq(ctx, rfqId, withLines(formValues(formData)));
    first = orders.length === 1 ? orders[0].id : "";
  });
  if (state.ok)
    redirect(
      first ? `/o/${orgSlug}/purchasing/orders/${first}` : `/o/${orgSlug}/purchasing/rfqs/${rfqId}`,
    );
  return state;
}
