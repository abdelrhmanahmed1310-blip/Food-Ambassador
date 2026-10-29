import "server-only";
import { getTranslations } from "next-intl/server";
import type { SignUpLabels } from "@/components/auth-forms";
import { PASSWORD_MIN_LENGTH } from "@/modules/shared/schemas";

export async function signUpLabels(
  submit: "signUp" | "createAccount" | "create",
): Promise<SignUpLabels> {
  const t = await getTranslations();
  return {
    submit: submit === "create" ? t("common.create") : t(`auth.${submit}`),
    pending: t("common.saving"),
    yourDetails: t("auth.yourDetails"),
    name: t("auth.name"),
    email: t("auth.email"),
    password: t("auth.password"),
    passwordHint: t("auth.passwordHint", { min: PASSWORD_MIN_LENGTH }),
    organizationSection: t("auth.organizationSection"),
    organizationName: t("auth.organizationName"),
    baseCurrency: t("auth.baseCurrency"),
    baseCurrencyHint: t("auth.baseCurrencyHint"),
    timeZone: t("auth.timeZone"),
    select: "—",
  };
}
