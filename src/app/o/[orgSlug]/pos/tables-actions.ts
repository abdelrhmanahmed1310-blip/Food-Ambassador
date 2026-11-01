"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms/action-state";
import {
  addTabLines,
  cancelTab,
  createFloor,
  createTable,
  mergeTabs,
  moveTab,
  openTab,
  payTab,
  removeTabLine,
  sendTab,
  setTableArchived,
  updateTabLine,
  voidTabLine,
} from "@/modules/pos/tables";
import { cancelPaymentLink, createPaymentLink, refreshPaymentLink } from "@/modules/payments/links";
import { createCustomer, findCustomerByPhone } from "@/modules/pos/customers";
import { giftCardBalance, sellGiftCard } from "@/modules/pos/gift-cards";
import { couponForRegister } from "@/modules/pos/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { errorToState, formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createFloorAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createFloor(ctx, formValues(formData));
  });
}

export async function createTableAction(
  orgSlug: string,
  floorId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createTable(ctx, floorId, formValues(formData));
  });
}

export async function setTableArchivedAction(
  orgSlug: string,
  tableId: string,
  archived: boolean,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setTableArchived(ctx, tableId, archived),
  );
}

/** Open a check at a table, or a named check without one, and go to it. */
export async function openTabAction(orgSlug: string, previous: S, formData: FormData) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await openTab(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/pos/tabs/${id}`);
  return state;
}

export type CheckResult =
  { ok: true; data?: Record<string, unknown> } | { ok: false; error: string };

/** The check screen calls these with data; errors come back localized. */
async function run(
  orgSlug: string,
  fn: (ctx: TenantContext) => Promise<Record<string, unknown> | void>,
): Promise<CheckResult> {
  const ctx = await requireTenant(orgSlug);
  try {
    const data = (await fn(ctx)) ?? undefined;
    revalidatePath(`/o/${orgSlug}/pos`, "layout");
    return { ok: true, data };
  } catch (error) {
    const state = await errorToState(error, {});
    return {
      ok: false,
      error: Object.values(state.fieldErrors ?? {})[0] ?? state.formError ?? "",
    };
  }
}

export async function addLinesAction(orgSlug: string, tabId: string, input: unknown) {
  return run(orgSlug, async (ctx) => {
    await addTabLines(ctx, tabId, input);
  });
}
export async function updateLineAction(orgSlug: string, lineId: string, input: unknown) {
  return run(orgSlug, (ctx) => updateTabLine(ctx, lineId, input));
}
export async function removeLineAction(orgSlug: string, lineId: string) {
  return run(orgSlug, (ctx) => removeTabLine(ctx, lineId));
}
export async function sendAction(orgSlug: string, tabId: string, input: unknown) {
  return run(orgSlug, async (ctx) => {
    const r = await sendTab(ctx, tabId, input);
    return { sent: r.sent };
  });
}
export async function voidLineAction(orgSlug: string, lineId: string, input: unknown) {
  return run(orgSlug, (ctx) => voidTabLine(ctx, lineId, input));
}
export async function moveAction(orgSlug: string, tabId: string, input: unknown) {
  return run(orgSlug, (ctx) => moveTab(ctx, tabId, input));
}
export async function mergeAction(orgSlug: string, tabId: string, input: unknown) {
  return run(orgSlug, (ctx) => mergeTabs(ctx, tabId, input));
}
export async function cancelAction(orgSlug: string, tabId: string, input: unknown) {
  return run(orgSlug, (ctx) => cancelTab(ctx, tabId, input));
}
export async function payAction(orgSlug: string, tabId: string, input: unknown) {
  return run(orgSlug, async (ctx) => {
    const r = await payTab(ctx, tabId, input);
    return {
      id: r.id,
      number: r.number,
      closed: r.closed,
      change: "change" in r && r.change ? r.change.toFixed() : "0",
    };
  });
}

export async function createLinkAction(orgSlug: string, tabId: string, input: unknown) {
  return run(orgSlug, async (ctx) => {
    const l = await createPaymentLink(ctx, tabId, input);
    return { id: l.id, url: l.url, amount: l.amount.toFixed() };
  });
}
export async function refreshLinkAction(orgSlug: string, linkId: string) {
  return run(orgSlug, async (ctx) => {
    const l = await refreshPaymentLink(ctx, linkId);
    return { status: l.status };
  });
}
export async function cancelLinkAction(orgSlug: string, linkId: string) {
  return run(orgSlug, (ctx) => cancelPaymentLink(ctx, linkId));
}

/** Look up a coupon for the till or a check before paying (ADR-067). */
export async function couponAction(orgSlug: string, registerId: string, code: string) {
  return run(orgSlug, (ctx) => couponForRegister(ctx, registerId, code));
}

/** The till's customer and gift card calls (ADR-068). */
export async function findCustomerAction(orgSlug: string, phone: string) {
  return run(orgSlug, (ctx) => findCustomerByPhone(ctx, phone));
}
export async function addCustomerAction(orgSlug: string, input: unknown) {
  return run(orgSlug, (ctx) => createCustomer(ctx, input));
}
export async function giftCardBalanceAction(orgSlug: string, code: string) {
  return run(orgSlug, (ctx) => giftCardBalance(ctx, code));
}
export async function sellGiftCardAction(orgSlug: string, input: unknown) {
  return run(orgSlug, async (ctx) => {
    const g = await sellGiftCard(ctx, input);
    return { code: g.code, last4: g.last4, balance: g.balance.toFixed() };
  });
}
