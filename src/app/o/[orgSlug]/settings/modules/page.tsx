import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ModulesForm } from "@/components/settings/modules-form";
import { Alert, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { getFeatureSettings } from "@/modules/features/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { saveModulesAction } from "./actions";

/** Switch modules and functions on or off for the organization (ADR-137). */
export default async function ModulesSettingsPage({
  params,
}: PageProps<"/o/[orgSlug]/settings/modules">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, modules] = await Promise.all([getTranslations("features"), getFeatureSettings(ctx)]);
  const name = (key: string) => t(`functions.${key}` as "functions.pos.till");
  const needs = (keys: string[]) =>
    keys.length ? t("needs", { names: keys.map(name).join(", ") }) : null;
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="space-y-6">
        <Alert tone="info">{t("notPermissions")}</Alert>
        <ModulesForm
          action={saveModulesAction.bind(null, orgSlug)}
          labels={{
            submit: t("save"),
            pending: t("saving"),
            core: t("core"),
            moduleOff: t("moduleOff"),
          }}
          modules={modules.map((m) => ({
            key: m.key,
            label: t(`modules.${m.key}` as "modules.pos"),
            switchable: m.switchable,
            on: m.on,
            needs: needs(m.requires),
            features: m.features.map((f) => ({
              key: f.key,
              label: name(f.key),
              core: f.core,
              on: f.on,
              needs: needs(f.requires),
            })),
          }))}
        />
      </div>
    </>
  );
}
