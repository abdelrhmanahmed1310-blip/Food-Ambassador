"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  createLocation,
  createWarehouse,
  setLocationArchived,
  setWarehouseArchived,
  updateLocation,
  updateWarehouse,
} from "@/modules/sites/warehouses";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createWarehouseAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createWarehouse(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/warehouses/${id}`);
  return state;
}

export async function updateWarehouseAction(
  orgSlug: string,
  warehouseId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateWarehouse(ctx, warehouseId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function setWarehouseArchivedAction(
  orgSlug: string,
  warehouseId: string,
  archived: boolean,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setWarehouseArchived(ctx, warehouseId, archived),
  );
}

export async function createLocationAction(
  orgSlug: string,
  warehouseId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("warehouses");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createLocation(ctx, warehouseId, formValues(formData));
    return { message: t("locationAdded") };
  });
}

export async function updateLocationAction(
  orgSlug: string,
  locationId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateLocation(ctx, locationId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function setLocationArchivedAction(
  orgSlug: string,
  locationId: string,
  archived: boolean,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setLocationArchived(ctx, locationId, archived),
  );
}
