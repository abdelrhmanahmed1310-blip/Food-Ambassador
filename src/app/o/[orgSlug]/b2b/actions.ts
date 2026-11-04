"use server";

import { getTranslations } from "next-intl/server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms/action-state";
import { recordCustomerReceipt, voidCustomerReceipt } from "@/modules/b2b/receivables";
import {
  addSalesOrderLine,
  cancelSalesInvoice,
  cancelSalesOrder,
  confirmSalesOrder,
  createCustomer,
  createSalesOrder,
  deliverSalesOrder,
  invoiceDelivery,
  removeSalesOrderLine,
  reverseDelivery,
  updateCustomerEInvoiceDetails,
  setCustomerGroupCompany,
} from "@/modules/b2b/service";
import { clearSalesInvoice } from "@/modules/zatca/service";
import { formValues } from "@/server/actions/handle";
import { logger } from "@/server/logger";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createCustomerAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createCustomer(ctx, formValues(formData));
  });
}

export async function createSalesOrderAction(orgSlug: string, previous: S, formData: FormData) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createSalesOrder(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/b2b/orders/${id}`);
  return state;
}

export async function addSalesOrderLineAction(
  orgSlug: string,
  orderId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addSalesOrderLine(ctx, orderId, formValues(formData)),
  );
}

export async function removeSalesOrderLineAction(
  orgSlug: string,
  orderId: string,
  lineId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeSalesOrderLine(ctx, orderId, lineId),
  );
}

export async function confirmSalesOrderAction(
  orgSlug: string,
  orderId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => confirmSalesOrder(ctx, orderId));
}

export async function cancelSalesOrderAction(
  orgSlug: string,
  orderId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelSalesOrder(ctx, orderId, formValues(formData)),
  );
}

export async function deliverSalesOrderAction(
  orgSlug: string,
  orderId: string,
  previous: S,
  formData: FormData,
) {
  const values = formValues(formData);
  const lines: Array<Record<string, string>> = [];
  for (const [k, v] of Object.entries(values)) {
    const m = /^lines\.(\d{1,3})\.(lineId|quantity)$/.exec(k);
    if (m) (lines[Number(m[1])] ??= {})[m[2]] = v;
  }
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await deliverSalesOrder(ctx, orderId, {
      lines: lines.filter(Boolean),
      idempotencyKey: values.idempotencyKey,
    });
  });
}

export async function reverseDeliveryAction(
  orgSlug: string,
  deliveryId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    reverseDelivery(ctx, deliveryId, formValues(formData)),
  );
}

export async function invoiceDeliveryAction(
  orgSlug: string,
  deliveryId: string,
  previous: S,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await invoiceDelivery(ctx, deliveryId, formValues(formData))).id;
    // Clear with ZATCA now; if ZATCA does not answer, the scheduled job retries (ADR-072).
    await clearSalesInvoice(ctx, id).catch((e) =>
      logger.warn("zatca clearance deferred", { invoice: id, error: (e as Error).message }),
    );
  });
  if (state.ok) redirect(`/o/${orgSlug}/b2b/invoices/${id}`);
  return state;
}

export async function cancelSalesInvoiceAction(
  orgSlug: string,
  invoiceId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await cancelSalesInvoice(ctx, invoiceId, formValues(formData));
    await clearSalesInvoice(ctx, invoiceId).catch((e) =>
      logger.warn("zatca clearance deferred", { invoice: invoiceId, error: (e as Error).message }),
    );
  });
}

/** "Clear now" for an invoice ZATCA has not cleared yet. */
export async function clearSalesInvoiceAction(
  orgSlug: string,
  invoiceId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await clearSalesInvoice(ctx, invoiceId);
  });
}

export async function recordCustomerReceiptAction(
  orgSlug: string,
  customerId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await recordCustomerReceipt(ctx, { ...formValues(formData), customerId });
  });
}

export async function voidCustomerReceiptAction(
  orgSlug: string,
  receiptId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    voidCustomerReceipt(ctx, receiptId, formValues(formData)),
  );
}

export async function updateEInvoiceDetailsAction(
  orgSlug: string,
  customerId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    updateCustomerEInvoiceDetails(ctx, customerId, formValues(formData)),
  );
}

export async function setGroupCompanyAction(
  orgSlug: string,
  customerId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setCustomerGroupCompany(ctx, customerId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}
