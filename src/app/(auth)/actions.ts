"use server";

import { isAPIError } from "better-auth/api";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { z } from "zod";
import type { ActionState } from "@/components/forms/action-state";
import { LOCALE_COOKIE, isLocale } from "@/i18n/config";
import { acceptInvitation, previewInvitation } from "@/modules/members/service";
import { createOrganizationSchema } from "@/modules/organizations/schemas";
import { createOrganization, listUserOrganizations } from "@/modules/organizations/service";
import { emailSchema, requiredText } from "@/modules/shared/schemas";
import { echoValues, errorToState, formValues } from "@/server/actions/handle";
import {
  AUTH_RATE_LIMITS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  getAuth,
} from "@/server/auth/auth";
import { getCurrentUser, safeNextPath } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { validationFailed } from "@/server/errors";
import { logger } from "@/server/logger";
import { consumeRateLimit } from "@/server/rate-limit";
import { getClientIp, getRequestId } from "@/server/request";

const passwordSchema = z
  .string({ error: "required" })
  .min(1, { error: "required" })
  .min(PASSWORD_MIN_LENGTH, { error: "passwordTooShort" })
  .max(PASSWORD_MAX_LENGTH, { error: "passwordTooLong" });

const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { error: "required" }),
});
const accountSchema = z.object({
  name: requiredText(100),
  email: emailSchema,
  password: passwordSchema,
});

async function rememberLocale(userId: string, preferExisting: boolean) {
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { locale: true } });
  let locale = user?.locale;
  if (!preferExisting || !isLocale(locale)) {
    locale = await getLocale();
    await getDb().user.update({ where: { id: userId }, data: { locale } });
  }
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: true,
  });
}

async function homePathFor(userId: string): Promise<string> {
  const orgs = await listUserOrganizations(userId);
  return orgs[0] ? `/o/${orgs[0].slug}` : "/organizations/new";
}

export async function signInAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations();
  const values = echoValues(formData);
  const parsed = credentialsSchema.safeParse(formValues(formData));
  if (!parsed.success) return errorToState(validationFailed(parsed.error), previous, values);
  const { email, password } = parsed.data;

  const limit = await consumeRateLimit(
    `signin:${await getClientIp()}:${email}`,
    AUTH_RATE_LIMITS.signIn,
  );
  if (!limit.allowed)
    return {
      ok: false,
      seq: (previous.seq ?? 0) + 1,
      formError: t("auth.rateLimited", { seconds: limit.retryAfter ?? 60 }),
      values,
    };

  const user = await getDb().user.findUnique({
    where: { email },
    select: { id: true, status: true },
  });
  const fail: ActionState = {
    ok: false,
    seq: (previous.seq ?? 0) + 1,
    formError: t("auth.invalidCredentials"),
    values,
  };
  if (!user || user.status !== "ACTIVE") return fail;
  try {
    await getAuth().api.signInEmail({ body: { email, password }, headers: await headers() });
  } catch (error) {
    if (isAPIError(error)) return fail;
    logger.error("sign-in failed", { error });
    return errorToState(error, previous, values);
  }
  await rememberLocale(user.id, true);
  redirect(safeNextPath(formData.get("next")) ?? (await homePathFor(user.id)));
}

/**
 * Create an account. Without an invitation this also creates the user's
 * organization (they become Owner); with an invitation token the account
 * joins the inviting organization instead.
 */
export async function signUpAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations();
  const input = formValues(formData);
  const values = echoValues(formData);
  const inviteToken = input.inviteToken ? input.inviteToken : undefined;

  const account = accountSchema.safeParse(input);
  const org = inviteToken
    ? null
    : createOrganizationSchema.safeParse({ ...input, name: input.organizationName });
  if (!account.success || (org && !org.success)) {
    const issues = [
      ...(account.success ? [] : account.error.issues),
      ...(org && !org.success
        ? org.error.issues.map((i) => ({
            ...i,
            path: i.path[0] === "name" ? ["organizationName"] : i.path,
          }))
        : []),
    ];
    return errorToState(validationFailed(new z.ZodError(issues)), previous, values);
  }
  const { name, email, password } = account.data;

  if (inviteToken) {
    const invitation = await previewInvitation(inviteToken);
    if (!invitation?.valid)
      return {
        ok: false,
        seq: (previous.seq ?? 0) + 1,
        formError: t("rules.INVITATION_NOT_PENDING"),
        values,
      };
    if (invitation.email !== email) {
      return {
        ok: false,
        seq: (previous.seq ?? 0) + 1,
        fieldErrors: { email: t("invite.forEmail", { email: invitation.email }) },
        values,
      };
    }
  }

  const limit = await consumeRateLimit(`signup:${await getClientIp()}`, AUTH_RATE_LIMITS.signUp);
  if (!limit.allowed)
    return {
      ok: false,
      seq: (previous.seq ?? 0) + 1,
      formError: t("auth.rateLimited", { seconds: limit.retryAfter ?? 60 }),
      values,
    };

  let userId: string;
  try {
    const result = await getAuth().api.signUpEmail({
      body: { name, email, password },
      headers: await headers(),
    });
    userId = result.user.id;
  } catch (error) {
    if (isAPIError(error) && String(error.body?.code ?? "").startsWith("USER_ALREADY_EXISTS")) {
      return {
        ok: false,
        seq: (previous.seq ?? 0) + 1,
        fieldErrors: { email: t("auth.emailTaken") },
        values,
      };
    }
    if (isAPIError(error))
      return {
        ok: false,
        seq: (previous.seq ?? 0) + 1,
        formError: t("errors.VALIDATION_FAILED"),
        values,
      };
    return errorToState(error, previous, values);
  }
  await rememberLocale(userId, false);

  let destination: string;
  try {
    const requestId = await getRequestId();
    if (inviteToken) {
      destination = `/o/${(await acceptInvitation({ id: userId, email }, inviteToken, requestId)).organizationSlug}`;
    } else {
      destination = `/o/${(await createOrganization(userId, org!.data!, requestId)).slug}`;
    }
  } catch (error) {
    // The account exists; the user can retry from /organizations/new or the invitation link.
    logger.error("post sign-up step failed", { error });
    destination = inviteToken ? `/invite/${inviteToken}` : "/organizations/new";
  }
  redirect(destination);
}

export async function signOutAction(): Promise<void> {
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

export async function acceptInvitationAction(
  token: string,
  previous: ActionState,
): Promise<ActionState> {
  const user = await getCurrentUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);
  let slug: string;
  try {
    slug = (await acceptInvitation(user, token, await getRequestId())).organizationSlug;
  } catch (error) {
    return errorToState(error, previous);
  }
  redirect(`/o/${slug}`);
}

export async function createOrganizationAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  let slug: string;
  try {
    const locale = await getLocale();
    const input = {
      name: String(formData.get("organizationName") ?? ""),
      baseCurrency: String(formData.get("baseCurrency") ?? ""),
      timeZone: String(formData.get("timeZone") ?? ""),
      defaultLocale: isLocale(locale) ? locale : undefined,
    };
    slug = (await createOrganization(user.id, input, await getRequestId())).slug;
  } catch (error) {
    const state = await errorToState(error, previous, echoValues(formData));
    if (state.fieldErrors?.name)
      state.fieldErrors = { ...state.fieldErrors, organizationName: state.fieldErrors.name };
    return state;
  }
  redirect(`/o/${slug}`);
}
