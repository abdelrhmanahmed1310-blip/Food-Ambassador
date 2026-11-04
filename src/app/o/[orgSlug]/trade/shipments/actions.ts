"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addContainer,
  advanceShipment,
  cancelShipment,
  createShipment,
  linkOrder,
  linkReceipt,
  removeContainer,
  unlinkOrder,
  updateShipment,
} from "@/modules/trade/shipments";
import { postShipmentCharge, recordCustomsEntry } from "@/modules/trade/charges";
import type { TenantContext } from "@/modules/tenancy/context";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createShipmentAction(orgSlug: string, previous: S, formData: FormData) {
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createShipment(ctx, formValues(formData))).id;
  });
  if (id) redirect(`/o/${orgSlug}/trade/shipments/${id}`);
  return result;
}

async function saved<T>(
  orgSlug: string,
  previous: S,
  formData: FormData,
  run: (ctx: TenantContext) => Promise<T>,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await run(ctx);
    return { message: t("savedSuccessfully") };
  });
}

export async function updateShipmentAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => updateShipment(ctx, id, formValues(formData)));
}
export async function addContainerAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => addContainer(ctx, id, formValues(formData)));
}
export async function removeContainerAction(
  orgSlug: string,
  id: string,
  containerId: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => removeContainer(ctx, id, containerId));
}
export async function linkOrderAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => linkOrder(ctx, id, formValues(formData)));
}
export async function unlinkOrderAction(
  orgSlug: string,
  id: string,
  orderId: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => unlinkOrder(ctx, id, orderId));
}
export async function linkReceiptAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => linkReceipt(ctx, id, formValues(formData)));
}
export async function advanceShipmentAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    advanceShipment(ctx, id, formValues(formData)),
  );
}
export async function cancelShipmentAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => cancelShipment(ctx, id, formValues(formData)));
}
export async function recordCustomsEntryAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    recordCustomsEntry(ctx, id, formValues(formData)),
  );
}
export async function postShipmentChargeAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    postShipmentCharge(ctx, id, formValues(formData)),
  );
}
