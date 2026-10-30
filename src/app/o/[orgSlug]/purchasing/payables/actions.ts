"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { updateAccountingSettings } from "@/modules/invoices/accounting";
import {
  allocateSettlement,
  recordCreditNote,
  recordPayment,
  voidSettlement,
} from "@/modules/invoices/payables";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

/** `allocations.N.field` form fields → `allocations: [{ field }]`. */
function settlementInput(values: Record<string, string>) {
  const allocations: Array<Record<string, string>> = [];
  const header: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const m = /^allocations\.(\d{1,3})\.([A-Za-z]+)$/.exec(key);
    if (m) (allocations[Number(m[1])] ??= {})[m[2]] = value;
    else header[key] = value;
  }
  return { ...header, allocations: allocations.filter(Boolean) };
}

export async function recordPaymentAction(
  orgSlug: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await recordPayment(ctx, { ...settlementInput(formValues(formData)), supplierId })).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/purchasing/payables/settlements/${id}`);
  return state;
}

export async function recordCreditNoteAction(
  orgSlug: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await recordCreditNote(ctx, { ...settlementInput(formValues(formData)), supplierId })).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/purchasing/payables/settlements/${id}`);
  return state;
}

export async function allocateSettlementAction(
  orgSlug: string,
  settlementId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    allocateSettlement(ctx, settlementId, settlementInput(formValues(formData))),
  );
}

export async function voidSettlementAction(
  orgSlug: string,
  settlementId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    voidSettlement(ctx, settlementId, formValues(formData)),
  );
}

export async function updateAccountingSettingsAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateAccountingSettings(ctx, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}
