"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addManualPunch,
  createAttendanceDevice,
  createTerminal,
  setEmployeePin,
  setGeofence,
  setTerminalActive,
  voidPunch,
} from "@/modules/hr/attendance";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";
import { getEnv } from "@/server/env";

type S = ActionState;

export async function setPinAction(
  orgSlug: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("attendance");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setEmployeePin(ctx, employeeId, formValues(formData));
    return { message: t("pinSet") };
  });
}

export async function manualPunchAction(
  orgSlug: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("attendance");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addManualPunch(ctx, employeeId, formValues(formData));
    return { message: t("punchAdded") };
  });
}

export async function voidPunchAction(
  orgSlug: string,
  punchId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await voidPunch(ctx, punchId, formValues(formData));
  });
}

export async function createTerminalAction(orgSlug: string, previous: S, formData: FormData) {
  const t = await getTranslations("attendance");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createTerminal(ctx, formValues(formData));
    return { message: t("terminalAdded") };
  });
}

export async function setTerminalActiveAction(
  orgSlug: string,
  terminalId: string,
  active: boolean,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setTerminalActive(ctx, terminalId, active),
  );
}

export async function setGeofenceAction(
  orgSlug: string,
  branchId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("attendance");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setGeofence(ctx, branchId, formValues(formData));
    return { message: t("locationSaved") };
  });
}

export async function removeGeofenceAction(
  orgSlug: string,
  branchId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => setGeofence(ctx, branchId, null));
}

// The secret travels back once in the action result; it is never stored in clear.
export async function createDeviceAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const d = await createAttendanceDevice(ctx, formValues(formData));
    return {
      data: {
        secret: d.secret,
        endpoint: `${getEnv().APP_URL}/api/integrations/inbound/${d.publicId}`,
      },
    };
  });
}
