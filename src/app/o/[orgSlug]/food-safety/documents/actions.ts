"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  approveFsDocument,
  confirmFsDocumentRead,
  createFsDocument,
  newFsDocumentVersion,
  updateFsDocumentDraft,
  withdrawFsDocument,
} from "@/modules/foodsafety/documents";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createDocumentAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createFsDocument(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/food-safety/documents/${id}`);
  return state;
}

export async function saveDraftAction(
  orgSlug: string,
  documentId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateFsDocumentDraft(ctx, documentId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function approveDocumentAction(
  orgSlug: string,
  documentId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    approveFsDocument(ctx, documentId, formValues(formData)),
  );
}

export async function newDocumentVersionAction(
  orgSlug: string,
  documentId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await newFsDocumentVersion(ctx, documentId);
  });
}

export async function withdrawDocumentAction(
  orgSlug: string,
  documentId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    withdrawFsDocument(ctx, documentId, formValues(formData)),
  );
}

export async function confirmReadAction(
  orgSlug: string,
  documentId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    confirmFsDocumentRead(ctx, documentId),
  );
}
