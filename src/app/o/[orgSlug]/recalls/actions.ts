"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms/action-state";
import {
  activateRecall,
  addRecallLots,
  cancelRecall,
  closeRecall,
  createRecall,
  removeRecallLot,
} from "@/modules/traceability/recalls";
import { lotsFromSupplier } from "@/modules/traceability/trace";
import { formList, formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createRecallAction(
  orgSlug: string,
  lotId: string | undefined,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createRecall(ctx, formValues(formData))).id;
    if (lotId) await addRecallLots(ctx, id, { lotIds: [lotId] });
  });
  if (state.ok) redirect(`/o/${orgSlug}/recalls/${id}`);
  return state;
}

export async function addRecallLotsAction(
  orgSlug: string,
  recallId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addRecallLots(ctx, recallId, { lotIds: formList(formData, "lotId") });
  });
}

export async function addSupplierLotsAction(
  orgSlug: string,
  recallId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const v = formValues(formData);
    const lotIds = await lotsFromSupplier(ctx, v.supplierId ?? "", v.productId || undefined);
    await addRecallLots(ctx, recallId, { lotIds });
  });
}

export async function removeRecallLotAction(
  orgSlug: string,
  recallId: string,
  lotId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeRecallLot(ctx, recallId, lotId),
  );
}

export async function activateRecallAction(
  orgSlug: string,
  recallId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await activateRecall(ctx, recallId);
  });
}

export async function closeRecallAction(
  orgSlug: string,
  recallId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await closeRecall(ctx, recallId, formValues(formData));
  });
}

export async function cancelRecallAction(
  orgSlug: string,
  recallId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelRecall(ctx, recallId, formValues(formData)),
  );
}
