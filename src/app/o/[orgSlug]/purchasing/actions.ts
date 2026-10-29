"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addOrderLine,
  approveOrder,
  cancelOrder,
  closeOrder,
  createOrder,
  rejectOrder,
  removeOrderLine,
  submitOrder,
  updateOrderHeader,
} from "@/modules/procurement/orders";
import { postReceipt, reverseReceipt } from "@/modules/procurement/receipts";
import { updateProcurementSettings } from "@/modules/procurement/settings";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createOrderAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createOrder(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/purchasing/orders/${id}`);
  return state;
}

export async function updateOrderHeaderAction(
  orgSlug: string,
  orderId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateOrderHeader(ctx, orderId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function addOrderLineAction(
  orgSlug: string,
  orderId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addOrderLine(ctx, orderId, formValues(formData));
  });
}

export async function removeOrderLineAction(
  orgSlug: string,
  orderId: string,
  lineId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeOrderLine(ctx, orderId, lineId),
  );
}

export async function submitOrderAction(
  orgSlug: string,
  orderId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await submitOrder(ctx, orderId);
  });
}

export async function approveOrderAction(
  orgSlug: string,
  orderId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => approveOrder(ctx, orderId));
}

export async function rejectOrderAction(
  orgSlug: string,
  orderId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    rejectOrder(ctx, orderId, formValues(formData)),
  );
}

export async function closeOrderAction(
  orgSlug: string,
  orderId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    closeOrder(ctx, orderId, formValues(formData)),
  );
}

export async function cancelOrderAction(
  orgSlug: string,
  orderId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelOrder(ctx, orderId, formValues(formData)),
  );
}

/** "lines.<i>.<field>" form keys → { lines: [{ field }] } for the receipt service. */
function receiptInput(values: Record<string, string>) {
  const lines: Array<Record<string, string>> = [];
  const header: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const m = /^lines\.(\d{1,3})\.([A-Za-z]+)$/.exec(key);
    if (m) (lines[Number(m[1])] ??= {})[m[2]] = value;
    else header[key] = value;
  }
  return { ...header, lines: lines.filter(Boolean) };
}

export async function postReceiptAction(
  orgSlug: string,
  orderId: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await postReceipt(ctx, orderId, receiptInput(formValues(formData)))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/purchasing/receipts/${id}`);
  return state;
}

export async function reverseReceiptAction(
  orgSlug: string,
  receiptId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await reverseReceipt(ctx, receiptId, formValues(formData));
  });
}

export async function updateProcurementSettingsAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateProcurementSettings(ctx, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}
