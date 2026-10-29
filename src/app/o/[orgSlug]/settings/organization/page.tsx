import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { OrganizationForm } from "@/components/settings/settings-forms";
import { Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { timeZoneOptions } from "@/lib/reference-data";
import { hasPermission } from "@/modules/access/authorize";
import { getOrganizationSettings } from "@/modules/organizations/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { updateOrganizationAction } from "../actions";

export default async function OrganizationSettingsPage({
  params,
}: PageProps<"/o/[orgSlug]/settings/organization">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, org] = await Promise.all([getTranslations(), getOrganizationSettings(ctx)]);
  return (
    <>
      <PageHeader title={t("settings.organizationTitle")} />
      <div className="space-y-6">
        <Card>
          <OrganizationForm
            action={updateOrganizationAction.bind(null, orgSlug)}
            labels={{
              submit: t("common.save"),
              pending: t("common.saving"),
              name: t("settings.name"),
              timeZone: t("settings.timeZone"),
              defaultLocale: t("settings.defaultLocale"),
            }}
            timeZones={timeZoneOptions()}
            locales={[
              { value: "en", label: t("locale.en") },
              { value: "ar", label: t("locale.ar") },
            ]}
            defaults={{ name: org.name, timeZone: org.timeZone, defaultLocale: org.defaultLocale }}
          />
        </Card>
        <Card>
          <DescriptionList
            items={[
              {
                label: t("settings.slug"),
                value: <span className="ltr-value font-mono">/o/{org.slug}</span>,
              },
              {
                label: t("settings.baseCurrency"),
                value: (
                  <span>
                    <span className="ltr-value font-mono">{org.baseCurrency}</span>{" "}
                    <span className="text-muted text-xs">({t("settings.currencyLocked")})</span>
                  </span>
                ),
              },
            ]}
          />
        </Card>
      </div>
    </>
  );
}
