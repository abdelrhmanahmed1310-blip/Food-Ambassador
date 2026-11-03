"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms/action-state";
import {
  addSupplierReturnLine,
  cancelSupplierReturn,
  createSupplierReturn,
  linkReturnCreditNote,
  postSupplierReturn,
  removeSupplierReturnLine,
  reverseSupplierReturn,
} from "@/modules/procurement/returns";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createReturnAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createSupplierReturn(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/purchasing/returns/${id}`);
  return state;
}

export async function addReturnLineAction(
  orgSlug: string,
  returnId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addSupplierReturnLine(ctx, returnId, formValues(formData));
  });
}

export async function removeReturnLineAction(
  orgSlug: string,
  returnId: string,
  lineId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeSupplierReturnLine(ctx, returnId, lineId),
  );
}

export async function postReturnAction(
  orgSlug: string,
  returnId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await postSupplierReturn(ctx, returnId);
  });
}

export async function cancelReturnAction(
  orgSlug: string,
  returnId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelSupplierReturn(ctx, returnId, formValues(formData)),
  );
}

export async function reverseReturnAction(
  orgSlug: string,
  returnId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    reverseSupplierReturn(ctx, returnId, formValues(formData)),
  );
}

export async function linkCreditAction(
  orgSlug: string,
  returnId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    linkReturnCreditNote(ctx, returnId, formValues(formData)),
  );
}
