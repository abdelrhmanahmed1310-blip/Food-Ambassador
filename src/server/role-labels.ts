import "server-only";
import { getTranslations } from "next-intl/server";
import type { RoleScopeLabels } from "@/components/settings/settings-forms";

type Translator = Awaited<ReturnType<typeof getTranslations>>;

/** System roles are shown by translated name; custom roles by their stored name. */
export function roleLabel(t: Translator, role: { key: string; name: string }): string {
  return t.has(`roles.names.${role.key}`) ? t(`roles.names.${role.key}`) : role.name;
}

export async function roleScopeLabels(): Promise<RoleScopeLabels> {
  const t = await getTranslations("members");
  return {
    role: t("role"),
    scope: t("scope"),
    branch: t("branch"),
    warehouse: t("warehouse"),
    scopeTypes: {
      ORGANIZATION: t("scopeTypes.ORGANIZATION"),
      BRANCH: t("scopeTypes.BRANCH"),
      WAREHOUSE: t("scopeTypes.WAREHOUSE"),
    },
  };
}
