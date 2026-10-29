"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  createSupplier,
  removeSupplierProduct,
  saveSupplierProduct,
  setSupplierArchived,
  updateSupplier,
} from "@/modules/procurement/suppliers";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createSupplierAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createSupplier(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/suppliers/${id}`);
  return state;
}

export async function updateSupplierAction(
  orgSlug: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateSupplier(ctx, supplierId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function setSupplierArchivedAction(
  orgSlug: string,
  supplierId: string,
  archived: boolean,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setSupplierArchived(ctx, supplierId, archived),
  );
}

export async function saveSupplierProductAction(
  orgSlug: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await saveSupplierProduct(ctx, supplierId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function removeSupplierProductAction(
  orgSlug: string,
  supplierId: string,
  supplierProductId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeSupplierProduct(ctx, supplierId, supplierProductId),
  );
}
