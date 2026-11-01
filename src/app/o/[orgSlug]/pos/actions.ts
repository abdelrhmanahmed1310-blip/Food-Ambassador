"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms/action-state";
import {
  addCashMovement,
  closeShift,
  createRegister,
  openShift,
  postShortfalls,
  refundOrder,
  submitOrder,
  voidOrder,
} from "@/modules/pos/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { errorToState, formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createRegisterAction(orgSlug: string, previous: S, formData: FormData) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createRegister(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/pos/registers/${id}`);
  return state;
}

export async function openShiftAction(
  orgSlug: string,
  registerId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await openShift(ctx, registerId, formValues(formData));
  });
}

export async function cashMovementAction(
  orgSlug: string,
  shiftId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addCashMovement(ctx, shiftId, formValues(formData)),
  );
}

export async function closeShiftAction(
  orgSlug: string,
  shiftId: string,
  previous: S,
  formData: FormData,
) {
  const state = await tenantMutation(orgSlug, previous, formData, (ctx) =>
    closeShift(ctx, shiftId, formValues(formData)),
  );
  if (state.ok) redirect(`/o/${orgSlug}/pos/shifts/${shiftId}`);
  return state;
}

export type SubmitOrderResult =
  | { ok: true; id: string; number: string; gross: string; change: string; shortfalls: number }
  | { ok: false; error: string };

/**
 * The till submits a whole paid order as data (not a form). The order id comes
 * from the device, so resubmitting after a lost response returns the same order.
 */
export async function submitOrderAction(
  orgSlug: string,
  payload: unknown,
): Promise<SubmitOrderResult> {
  const ctx = await requireTenant(orgSlug);
  try {
    const o = await submitOrder(ctx, payload);
    revalidatePath(`/o/${orgSlug}/pos`, "layout");
    return {
      ok: true,
      id: o.id,
      number: o.number,
      gross: o.gross.toFixed(),
      change: o.change.toFixed(),
      shortfalls: o.shortfalls,
    };
  } catch (error) {
    const state = await errorToState(error, {});
    const field = Object.values(state.fieldErrors ?? {})[0];
    return { ok: false, error: field ?? state.formError ?? "" };
  }
}

export async function voidOrderAction(
  orgSlug: string,
  orderId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    voidOrder(ctx, orderId, formValues(formData)),
  );
}

export async function refundOrderAction(
  orgSlug: string,
  orderId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const values = formValues(formData);
    const lines = Object.entries(values)
      .filter(([k, v]) => k.startsWith("qty_") && v.trim() !== "")
      .map(([k, v]) => ({ orderLineId: k.slice(4), quantity: v.trim() }));
    await refundOrder(ctx, orderId, {
      registerId: values.registerId,
      method: values.method,
      reason: values.reason,
      lines,
    });
  });
}

export async function postShortfallsAction(
  orgSlug: string,
  warehouseId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await postShortfalls(ctx, warehouseId);
    return { data: { posted: String(r.posted), remaining: String(r.remaining) } };
  });
}
