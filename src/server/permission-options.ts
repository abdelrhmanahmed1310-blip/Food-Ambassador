import "server-only";
import { getTranslations } from "next-intl/server";
import { PERMISSIONS } from "@/modules/access/permissions";

export async function permissionOptions() {
  const t = await getTranslations("roles.permissionLabels");
  return PERMISSIONS.map((p) => ({ value: p, label: t(p), hint: p }));
}
