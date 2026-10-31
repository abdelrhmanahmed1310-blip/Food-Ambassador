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
import { addReceiptLandedCost } from "@/modules/procurement/landed-costs";
import { postReceipt, reverseReceipt } from "@/modules/procurement/receipts";
import {
  addRequisitionLine,
  cancelRequisition,
  closeRequisition,
  createRequisition,
  fulfilRequisitionFromStock,
  orderRequisition,
  rejectRequisition,
  removeRequisitionLine,
  submitRequisition,
} from "@/modules/procurement/requisitions";
import {
  createOrdersFromPlan,
  removeReorderRule,
  saveReorderRule,
} from "@/modules/procurement/reorder";
import { updateProcurementSettings } from "@/modules/procurement/settings";
import { formList, formValues } from "@/server/actions/handle";
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

export async function saveReorderRuleAction(
  orgSlug: string,
  warehouseId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await saveReorderRule(ctx, { ...formValues(formData), warehouseId });
    return { message: t("savedSuccessfully") };
  });
}

export async function removeReorderRuleAction(
  orgSlug: string,
  ruleId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => removeReorderRule(ctx, ruleId));
}

export async function createOrdersFromPlanAction(
  orgSlug: string,
  warehouseId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("reorder");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const { orders, skipped } = await createOrdersFromPlan(
      ctx,
      warehouseId,
      formList(formData, "ruleId"),
    );
    const created = t("ordersCreated", {
      count: orders.length,
      numbers: orders.map((o) => o.number).join(", "),
    });
    return {
      message:
        skipped.length > 0 ? `${created} ${t("skipped", { skus: skipped.join(", ") })}` : created,
    };
  });
}

export async function addLandedCostAction(
  orgSlug: string,
  receiptId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addReceiptLandedCost(ctx, receiptId, formValues(formData));
  });
}

// ─── Requisitions ───

export async function createRequisitionAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createRequisition(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/purchasing/requisitions/${id}`);
  return state;
}

export async function addRequisitionLineAction(
  orgSlug: string,
  requisitionId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addRequisitionLine(ctx, requisitionId, formValues(formData)),
  );
}

export async function removeRequisitionLineAction(
  orgSlug: string,
  requisitionId: string,
  lineId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeRequisitionLine(ctx, requisitionId, lineId),
  );
}

export async function submitRequisitionAction(
  orgSlug: string,
  requisitionId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    submitRequisition(ctx, requisitionId),
  );
}

export async function cancelRequisitionAction(
  orgSlug: string,
  requisitionId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelRequisition(ctx, requisitionId, formValues(formData)),
  );
}

export async function rejectRequisitionAction(
  orgSlug: string,
  requisitionId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    rejectRequisition(ctx, requisitionId, formValues(formData)),
  );
}

export async function closeRequisitionAction(
  orgSlug: string,
  requisitionId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    closeRequisition(ctx, requisitionId, formValues(formData)),
  );
}

export async function orderRequisitionAction(
  orgSlug: string,
  requisitionId: string,
  previous: ActionState,
  formData: FormData,
) {
  let orderId = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    orderId = (await orderRequisition(ctx, requisitionId, receiptInput(formValues(formData))))
      .orderId;
  });
  if (state.ok) redirect(`/o/${orgSlug}/purchasing/orders/${orderId}`);
  return state;
}

export async function fulfilRequisitionAction(
  orgSlug: string,
  requisitionId: string,
  previous: ActionState,
  formData: FormData,
) {
  let shipmentId = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    shipmentId = (
      await fulfilRequisitionFromStock(ctx, requisitionId, {
        fromWarehouseId: formData.get("fromWarehouseId"),
        lineIds: formList(formData, "lineIds"),
        idempotencyKey: formData.get("idempotencyKey") ?? undefined,
      })
    ).shipmentId;
  });
  if (state.ok) redirect(`/o/${orgSlug}/inventory/shipments/${shipmentId}`);
  return state;
}
