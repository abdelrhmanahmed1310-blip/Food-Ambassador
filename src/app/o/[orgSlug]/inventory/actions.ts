"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addCountLine,
  cancelCount,
  createCount,
  postCount,
  recordCountedQuantity,
  submitCount,
} from "@/modules/inventory/counts";
import {
  postAdjustment,
  postOpeningBalance,
  postStatusChange,
  postTransfer,
  postWriteOff,
  reverseDocument,
  revalueStock,
} from "@/modules/inventory/operations";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

/** Posting forms redirect to the new document, which shows exactly what was posted. */
async function postAndShow(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
  post: (
    ctx: Parameters<typeof postOpeningBalance>[0],
    input: Record<string, string>,
  ) => Promise<{ documentId: string }>,
): Promise<ActionState> {
  let documentId = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    documentId = (await post(ctx, formValues(formData))).documentId;
  });
  if (state.ok) redirect(`/o/${orgSlug}/inventory/documents/${documentId}`);
  return state;
}

/** The form's combined "warehouseId:locationId" picker value, split into the service's fields. */
function withPlace(input: Record<string, string>): Record<string, string> {
  const [warehouseId = "", locationId = ""] = (input.place ?? "").split(":");
  return { ...input, warehouseId, locationId };
}

export async function openingBalanceAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  return postAndShow(orgSlug, previous, formData, (ctx, input) =>
    postOpeningBalance(ctx, withPlace(input)),
  );
}

export async function adjustmentAction(orgSlug: string, previous: ActionState, formData: FormData) {
  return postAndShow(orgSlug, previous, formData, (ctx, input) =>
    postAdjustment(ctx, withPlace(input)),
  );
}

export async function writeOffAction(orgSlug: string, previous: ActionState, formData: FormData) {
  return postAndShow(orgSlug, previous, formData, postWriteOff);
}

export async function transferAction(orgSlug: string, previous: ActionState, formData: FormData) {
  return postAndShow(orgSlug, previous, formData, (ctx, input) => {
    const [toWarehouseId = "", toLocationId = ""] = (input.destination ?? "").split(":");
    return postTransfer(ctx, { ...input, toWarehouseId, toLocationId });
  });
}

export async function statusChangeAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  return postAndShow(orgSlug, previous, formData, postStatusChange);
}

export async function reverseDocumentAction(
  orgSlug: string,
  documentId: string,
  previous: ActionState,
  formData: FormData,
) {
  let reversalId = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    reversalId = (await reverseDocument(ctx, documentId, formValues(formData))).documentId;
  });
  if (state.ok) redirect(`/o/${orgSlug}/inventory/documents/${reversalId}`);
  return state;
}

// ─── Counts ───

export async function createCountAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createCount(ctx, withPlace(formValues(formData)))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/inventory/counts/${id}`);
  return state;
}

/** Saves every count field that has a value (`line:<id>` inputs). */
export async function recordCountsAction(
  orgSlug: string,
  countId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("line:") || typeof value !== "string" || value.trim() === "") continue;
      try {
        await recordCountedQuantity(ctx, countId, key.slice(5), { countedQuantity: value });
      } catch (error) {
        // Point the field error at the input that failed.
        if (error instanceof Error && "details" in error) {
          const details = (
            error as { details?: { issues?: Array<{ path: string; message: string }> } }
          ).details;
          details?.issues?.forEach((i) => (i.path = key));
        }
        throw error;
      }
    }
    return { message: t("savedSuccessfully") };
  });
}

export async function addCountLineAction(
  orgSlug: string,
  countId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addCountLine(ctx, countId, formValues(formData)).then(() => undefined),
  );
}

export async function submitCountAction(
  orgSlug: string,
  countId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => submitCount(ctx, countId));
}

export async function postCountAction(
  orgSlug: string,
  countId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    postCount(ctx, countId).then(() => undefined),
  );
}

export async function cancelCountAction(
  orgSlug: string,
  countId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => cancelCount(ctx, countId));
}

export async function revalueAction(
  orgSlug: string,
  warehouseId: string,
  productId: string,
  previous: ActionState,
  formData: FormData,
) {
  return postAndShow(orgSlug, previous, formData, (ctx, input) =>
    // The product and warehouse come from the page URL (validated again in the service).
    revalueStock(ctx, { ...input, warehouseId, productId }),
  );
}
