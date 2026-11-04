"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addToLoad,
  cancelLoad,
  confirmLoaded,
  createLoad,
  dispatchLoad,
  packUnit,
  removeFromLoad,
  removePackUnit,
} from "@/modules/wms/loading";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

/** "lines.<i>.<field>" keys → { lines: [...] } (empty quantities dropped). */
function packInput(values: Record<string, string>) {
  const lines: Array<Record<string, string>> = [];
  const header: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const m = /^lines\.(\d{1,3})\.([A-Za-z]+)$/.exec(key);
    if (m) (lines[Number(m[1])] ??= {})[m[2]] = value;
    else header[key] = value;
  }
  return { ...header, lines: lines.filter((l) => l && l.quantity && l.quantity.trim()) };
}

export async function packAction(
  orgSlug: string,
  pickListId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("loads");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const u = await packUnit(ctx, pickListId, packInput(formValues(formData)));
    return { message: t("packed", { number: u.number }) };
  });
}

export async function removePackUnitAction(
  orgSlug: string,
  unitId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => removePackUnit(ctx, unitId));
}

export async function createLoadAction(orgSlug: string, previous: ActionState, formData: FormData) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createLoad(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/inventory/loads/${id}`);
  return state;
}

export async function addToLoadAction(
  orgSlug: string,
  loadId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addToLoad(ctx, loadId, formValues(formData).pickListId ?? ""),
  );
}

export async function removeFromLoadAction(
  orgSlug: string,
  loadId: string,
  pickListId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeFromLoad(ctx, loadId, pickListId),
  );
}

export async function confirmLoadedAction(
  orgSlug: string,
  loadId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("loads");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await confirmLoaded(ctx, loadId, formValues(formData));
    return { message: t("loaded", { number: r.number }) };
  });
}

export async function dispatchLoadAction(
  orgSlug: string,
  loadId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await dispatchLoad(ctx, loadId, formValues(formData));
  });
}

export async function cancelLoadAction(
  orgSlug: string,
  loadId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelLoad(ctx, loadId, formValues(formData)),
  );
}
