import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ProcurementSettingsForm } from "@/components/procurement/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { getProcurementSettings } from "@/modules/procurement/settings";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { updateProcurementSettingsAction } from "../../purchasing/actions";

export default async function PurchasingSettingsPage({
  params,
}: PageProps<"/o/[orgSlug]/settings/purchasing">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, rules] = await Promise.all([getTranslations(), getProcurementSettings(ctx)]);
  return (
    <>
      <PageHeader title={t("purchasing.settingsTitle")} />
      <Card>
        <ProcurementSettingsForm
          action={updateProcurementSettingsAction.bind(null, orgSlug)}
          currency={ctx.baseCurrency}
          defaults={{
            approvalThreshold: rules.approvalThreshold?.toFixed() ?? "",
            overReceiptTolerancePercent: rules.overReceiptTolerance.times(100).toFixed(),
          }}
        />
      </Card>
    </>
  );
}
