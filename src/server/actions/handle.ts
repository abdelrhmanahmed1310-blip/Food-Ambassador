import "server-only";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { PASSWORD_MIN_LENGTH } from "@/modules/shared/schemas";
import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";
import { getRequestId } from "@/server/request";

type Translator = Awaited<ReturnType<typeof getTranslations>>;

/** All string fields of a form (input to services). */
export function formValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && !key.startsWith("$")) values[key] = value;
  }
  return values;
}

/** Values echoed back to repopulate a form after an error — never secrets. */
export function echoValues(formData: FormData): Record<string, string> {
  const values = formValues(formData);
  delete values.password;
  return values;
}

/** All values for checkbox groups such as `permissions`. */
export function formList(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((v): v is string => typeof v === "string");
}

// Values available to every validation/error message placeholder.
const MESSAGE_VALUES = { min: PASSWORD_MIN_LENGTH };

/**
 * Translate `key` with placeholder values from the error details (e.g.
 * {available} for INSUFFICIENT_STOCK). Falls back if the key is unknown or a
 * placeholder is missing.
 */
function translateOr(
  t: Translator,
  key: string,
  fallback: string,
  details: Record<string, unknown> = {},
): string {
  if (!t.has(key)) return fallback;
  const values: Record<string, string | number> = { ...MESSAGE_VALUES };
  for (const [k, v] of Object.entries(details))
    if (typeof v === "string" || typeof v === "number") values[k] = v;
  try {
    return t(key, values);
  } catch {
    return fallback;
  }
}

/** Localize an error for display. Unknown errors are logged and shown generically. */
export async function errorToState(
  error: unknown,
  previous: ActionState,
  values?: Record<string, string>,
): Promise<ActionState> {
  const t = await getTranslations();
  const seq = (previous.seq ?? 0) + 1;
  if (!(error instanceof AppError)) {
    logger.error("server action failed", { error, requestId: await getRequestId() });
    return { ok: false, seq, formError: t("errors.INTERNAL"), values };
  }
  const details = error.details ?? {};
  if (error.code === "VALIDATION_FAILED") {
    const fieldErrors: Record<string, string> = {};
    for (const issue of (details.issues as Array<{ path: string; message: string }>) ?? []) {
      if (!fieldErrors[issue.path])
        fieldErrors[issue.path] = translateOr(
          t,
          `validation.${issue.message}`,
          t("validation.invalid"),
        );
    }
    return { ok: false, seq, formError: t("errors.VALIDATION_FAILED"), fieldErrors, values };
  }
  let message = t(`errors.${error.code}`);
  if (error.code === "BUSINESS_RULE_VIOLATION" && typeof details.rule === "string") {
    message = translateOr(t, `rules.${details.rule}`, message, details);
  } else if (typeof details.reason === "string") {
    message = translateOr(t, `errors.${details.reason}`, message);
  }
  if (typeof details.field === "string") {
    return {
      ok: false,
      seq,
      formError: t("errors.VALIDATION_FAILED"),
      fieldErrors: { [details.field]: message },
      values,
    };
  }
  return { ok: false, seq, formError: message, values };
}

/**
 * Run a mutation for a form action and convert the outcome to ActionState.
 * Redirects must happen after this returns (they work by throwing).
 */
export async function runFormAction(
  previous: ActionState,
  formData: FormData,
  fn: () => Promise<Partial<ActionState> | void>,
): Promise<ActionState> {
  try {
    const result = (await fn()) ?? {};
    return { ok: true, seq: (previous.seq ?? 0) + 1, ...result };
  } catch (error) {
    return errorToState(error, previous, echoValues(formData));
  }
}
