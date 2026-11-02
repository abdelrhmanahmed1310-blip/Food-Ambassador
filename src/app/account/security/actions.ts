"use server";

import { isAPIError } from "better-auth/api";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { getAuth } from "@/server/auth/auth";
import { requireUser } from "@/server/auth/session";
import { formValues } from "@/server/actions/handle";
import { logger } from "@/server/logger";

type S = ActionState;
const done = (previous: S, extra: Partial<ActionState> = {}): ActionState => ({
  ok: true,
  seq: (previous.seq ?? 0) + 1,
  ...extra,
});
const failed = (previous: S, formError: string): ActionState => ({
  ok: false,
  seq: (previous.seq ?? 0) + 1,
  formError,
});

/** Start: the password confirms it is the user; the secret and backup codes are shown once. */
export async function enableTwoFactorAction(previous: S, formData: FormData): Promise<ActionState> {
  await requireUser("/account/security");
  const t = await getTranslations("auth");
  const { password } = formValues(formData);
  try {
    const r = await getAuth().api.enableTwoFactor({
      body: { password: password ?? "", issuer: "Food Ambassador", method: "totp" },
      headers: await headers(),
    });
    if (r.method !== "totp") return failed(previous, t("tryAgain"));
    return done(previous, { data: { totpURI: r.totpURI, backupCodes: r.backupCodes.join(" ") } });
  } catch (error) {
    if (isAPIError(error)) return failed(previous, t("wrongPassword"));
    logger.error("enable two-factor failed", { error });
    return failed(previous, t("tryAgain"));
  }
}

/** Finish: a first code from the app proves it was set up; then sign-in asks for codes. */
export async function confirmTwoFactorAction(
  previous: S,
  formData: FormData,
): Promise<ActionState> {
  await requireUser("/account/security");
  const t = await getTranslations("auth");
  const code = (formValues(formData).code ?? "").replace(/\s/g, "");
  try {
    await getAuth().api.verifyTOTP({ body: { code }, headers: await headers() });
    return done(previous, { message: t("twoFactorOn") });
  } catch (error) {
    if (isAPIError(error)) return failed(previous, t("invalidCode"));
    logger.error("confirm two-factor failed", { error });
    return failed(previous, t("tryAgain"));
  }
}

export async function disableTwoFactorAction(
  previous: S,
  formData: FormData,
): Promise<ActionState> {
  await requireUser("/account/security");
  const t = await getTranslations("auth");
  const { password } = formValues(formData);
  try {
    await getAuth().api.disableTwoFactor({
      body: { password: password ?? "" },
      headers: await headers(),
    });
    return done(previous, { message: t("twoFactorOff") });
  } catch (error) {
    if (isAPIError(error)) return failed(previous, t("wrongPassword"));
    logger.error("disable two-factor failed", { error });
    return failed(previous, t("tryAgain"));
  }
}
