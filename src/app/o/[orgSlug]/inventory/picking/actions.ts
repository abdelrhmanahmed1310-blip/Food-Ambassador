"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  cancelPickList,
  confirmPick,
  createPickList,
  createWave,
  deliverPickList,
} from "@/modules/wms/picking";
import { formList, formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createPickListAction(
  orgSlug: string,
  salesOrderId: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createPickList(ctx, salesOrderId)).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/inventory/picking/${id}`);
  return state;
}

export async function createWaveAction(
  orgSlug: string,
  warehouseId: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (
      await createWave(ctx, {
        warehouseId,
        orderIds: formList(formData, "orderIds"),
        note: formValues(formData).note,
      })
    ).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/inventory/picking/waves/${id}`);
  return state;
}

/** "lines.<i>.<field>" keys → { lines: [...] }. */
function linesInput(values: Record<string, string>) {
  const lines: Array<Record<string, string>> = [];
  for (const [key, value] of Object.entries(values)) {
    const m = /^lines\.(\d{1,3})\.([A-Za-z]+)$/.exec(key);
    if (m) (lines[Number(m[1])] ??= {})[m[2]] = value;
  }
  return { lines: lines.filter(Boolean) };
}

export async function confirmPickAction(
  orgSlug: string,
  pickListId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("picking");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await confirmPick(ctx, pickListId, linesInput(formValues(formData)));
    return { message: t("pickedMessage", { number: r.document.number }) };
  });
}

export async function deliverPickListAction(
  orgSlug: string,
  pickListId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("picking");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const d = await deliverPickList(ctx, pickListId);
    return { message: t("deliveredMessage", { number: d.number }) };
  });
}

export async function cancelPickListAction(
  orgSlug: string,
  pickListId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelPickList(ctx, pickListId, formValues(formData)),
  );
}
