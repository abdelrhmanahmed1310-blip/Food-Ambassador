"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addChargeLine,
  addGoodsLine,
  approveException,
  cancelInvoice,
  createInvoice,
  postInvoice,
  removeInvoiceLine,
  updateInvoiceHeader,
} from "@/modules/invoices/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createInvoiceAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createInvoice(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/purchasing/invoices/${id}`);
  return state;
}

export async function updateInvoiceAction(
  orgSlug: string,
  invoiceId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateInvoiceHeader(ctx, invoiceId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function addGoodsLineAction(
  orgSlug: string,
  invoiceId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addGoodsLine(ctx, invoiceId, formValues(formData)),
  );
}

export async function addChargeLineAction(
  orgSlug: string,
  invoiceId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addChargeLine(ctx, invoiceId, formValues(formData)),
  );
}

export async function removeInvoiceLineAction(
  orgSlug: string,
  invoiceId: string,
  lineId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeInvoiceLine(ctx, invoiceId, lineId),
  );
}

export async function approveInvoiceAction(
  orgSlug: string,
  invoiceId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    approveException(ctx, invoiceId, formValues(formData)),
  );
}

export async function postInvoiceAction(
  orgSlug: string,
  invoiceId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => postInvoice(ctx, invoiceId));
}

export async function cancelInvoiceAction(
  orgSlug: string,
  invoiceId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelInvoice(ctx, invoiceId, formValues(formData)),
  );
}
