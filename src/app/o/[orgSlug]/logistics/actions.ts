"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addStop,
  cancelTrip,
  completeTrip,
  createTrip,
  createVehicle,
  deliverStop,
  failStop,
  recordReading,
  removeStop,
  setVehicleArchived,
  startTrip,
} from "@/modules/logistics/trips";
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

export async function createVehicleAction(orgSlug: string, previous: S, formData: FormData) {
  return saved(orgSlug, previous, formData, (ctx) => createVehicle(ctx, formValues(formData)));
}
export async function setVehicleArchivedAction(
  orgSlug: string,
  id: string,
  archived: boolean,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => setVehicleArchived(ctx, id, archived));
}
export async function createTripAction(
  orgSlug: string,
  warehouseId: string,
  previous: S,
  formData: FormData,
) {
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createTrip(ctx, { ...formValues(formData), warehouseId })).id;
  });
  if (id) redirect(`/o/${orgSlug}/logistics/trips/${id}`);
  return result;
}
export async function addStopAction(
  orgSlug: string,
  id: string,
  kind: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    addStop(ctx, id, { kind, consignmentId: formData.get("consignmentId") }),
  );
}
export async function removeStopAction(
  orgSlug: string,
  id: string,
  stopId: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => removeStop(ctx, id, stopId));
}
export async function startTripAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => startTrip(ctx, id, formValues(formData)));
}
export async function recordReadingAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => recordReading(ctx, id, formValues(formData)));
}
export async function deliverStopAction(
  orgSlug: string,
  id: string,
  stopId: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    deliverStop(ctx, id, stopId, formValues(formData)),
  );
}
export async function failStopAction(
  orgSlug: string,
  id: string,
  stopId: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) =>
    failStop(ctx, id, stopId, formValues(formData)),
  );
}
export async function completeTripAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => completeTrip(ctx, id, formValues(formData)));
}
export async function cancelTripAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return saved(orgSlug, previous, formData, (ctx) => cancelTrip(ctx, id, formValues(formData)));
}
