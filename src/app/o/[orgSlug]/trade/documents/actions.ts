"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addProductDocument,
  addShipmentDocument,
  archiveRequirement,
  archiveTradeDocument,
  createDocumentType,
  createRequirement,
  renewTradeDocument,
  setDocumentTypeArchived,
} from "@/modules/trade/documents";
import type { TenantContext } from "@/modules/tenancy/context";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

async function saved(
  orgSlug: string,
  previous: S,
  formData: FormData,
  run: (ctx: TenantContext) => Promise<unknown>,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await run(ctx);
    return { message: t("savedSuccessfully") };
  });
}

export async function createDocumentTypeAction(orgSlug: string, previous: S, formData: FormData) {
  return saved(orgSlug, previous, formData, (ctx) => createDocumentType(ctx, formValues(formData)));
}
export async function setDocumentTypeArchivedAction(
  orgSlug: string,
  id: string,
  archived: boolean,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => setDocumentTypeArchived(ctx, id, archived));
}
export async function createRequirementAction(orgSlug: string, previous: S, formData: FormData) {
  return saved(orgSlug, previous, formData, (ctx) => createRequirement(ctx, formValues(formData)));
}
export async function archiveRequirementAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => archiveRequirement(ctx, id));
}
export async function addShipmentDocumentAction(
  orgSlug: string,
  shipmentId: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    addShipmentDocument(ctx, shipmentId, formValues(formData)),
  );
}
export async function addProductDocumentAction(orgSlug: string, previous: S, formData: FormData) {
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await addProductDocument(ctx, formValues(formData))).id;
  });
  if (id) redirect(`/o/${orgSlug}/trade/documents/${id}`);
  return result;
}
export async function renewTradeDocumentAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    renewTradeDocument(ctx, id, formValues(formData)),
  );
}
export async function archiveTradeDocumentAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    archiveTradeDocument(ctx, id, formValues(formData)),
  );
}
