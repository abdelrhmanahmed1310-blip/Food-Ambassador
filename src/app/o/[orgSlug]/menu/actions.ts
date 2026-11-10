"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addComboComponent,
  addMenuItemPrice,
  addModifierOption,
  attachModifierGroup,
  createMenuCategory,
  createMenuItem,
  createModifierGroup,
  detachModifierGroup,
  removeComboComponent,
  setItemAvailability,
  setMenuItemArchived,
  setModifierOptionArchived,
  updateMenuItem,
} from "@/modules/menu/service";
import { formValues } from "@/server/actions/handle";
import { setMenuItemImage } from "@/modules/media/images";
import { photoFrom } from "@/server/actions/photo";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createMenuCategoryAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createMenuCategory(ctx, formValues(formData));
  });
}

export async function createMenuItemAction(orgSlug: string, previous: S, formData: FormData) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createMenuItem(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/menu/items/${id}`);
  return state;
}

export async function updateMenuItemAction(
  orgSlug: string,
  itemId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    updateMenuItem(ctx, itemId, formValues(formData)),
  );
}

export async function setMenuItemArchivedAction(
  orgSlug: string,
  itemId: string,
  archived: boolean,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setMenuItemArchived(ctx, itemId, archived),
  );
}

export async function addMenuItemPriceAction(
  orgSlug: string,
  itemId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addMenuItemPrice(ctx, itemId, formValues(formData)),
  );
}

export async function attachModifierGroupAction(
  orgSlug: string,
  itemId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    attachModifierGroup(ctx, itemId, formValues(formData)),
  );
}

export async function detachModifierGroupAction(
  orgSlug: string,
  itemId: string,
  groupId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    detachModifierGroup(ctx, itemId, groupId),
  );
}

export async function addComboComponentAction(
  orgSlug: string,
  comboId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addComboComponent(ctx, comboId, formValues(formData)),
  );
}

export async function removeComboComponentAction(
  orgSlug: string,
  comboId: string,
  componentId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeComboComponent(ctx, comboId, componentId),
  );
}

export async function setItemAvailabilityAction(
  orgSlug: string,
  itemId: string,
  branchId: string,
  available: boolean,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setItemAvailability(ctx, itemId, branchId, available),
  );
}

export async function createModifierGroupAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createModifierGroup(ctx, formValues(formData));
  });
}

export async function addModifierOptionAction(
  orgSlug: string,
  groupId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addModifierOption(ctx, groupId, formValues(formData));
  });
}

export async function setModifierOptionArchivedAction(
  orgSlug: string,
  optionId: string,
  archived: boolean,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setModifierOptionArchived(ctx, optionId, archived),
  );
}

/** Upload or replace the photo (ADR-133). */
export async function setMenuItemPhotoAction(
  orgSlug: string,
  itemId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("photos");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setMenuItemImage(ctx, itemId, await photoFrom(formData));
    return { message: t("saved") };
  });
}

export async function removeMenuItemPhotoAction(
  orgSlug: string,
  itemId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("photos");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setMenuItemImage(ctx, itemId, null);
    return { message: t("removed") };
  });
}
