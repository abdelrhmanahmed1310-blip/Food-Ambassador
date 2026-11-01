"use server";

import type { ActionState } from "@/components/forms/action-state";
import {
  bumpTicket,
  createStation,
  recallTicket,
  removeRoute,
  setRoute,
} from "@/modules/pos/kitchen";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createStationAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createStation(ctx, formValues(formData));
  });
}

export async function setRouteAction(
  orgSlug: string,
  stationId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setRoute(ctx, stationId, formValues(formData)),
  );
}

export async function removeRouteAction(
  orgSlug: string,
  routeId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => removeRoute(ctx, routeId));
}

export async function bumpAction(
  orgSlug: string,
  ticketId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => bumpTicket(ctx, ticketId));
}

export async function recallAction(
  orgSlug: string,
  ticketId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => recallTicket(ctx, ticketId));
}
