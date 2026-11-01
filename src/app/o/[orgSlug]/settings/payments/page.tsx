import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ProviderForm } from "@/components/payments/provider-form";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { paymentProvider } from "@/modules/payments/links";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { savePaymentProviderAction } from "./actions";

/** Online payments (Moyasar) for pay-by-QR at the table (ADR-066). */
export default async function PaymentsSettingsPage({
  params,
}: PageProps<"/o/[orgSlug]/settings/payments">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, format, provider] = await Promise.all([
    getTranslations(),
    getFormatter(),
    paymentProvider(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("onlinePayments.title")} description={t("onlinePayments.intro")} />
      <div className="space-y-6">
        <Alert tone="info">{t("onlinePayments.validationNote")}</Alert>
        <Card title={t("onlinePayments.account")}>
          <p className="mb-4 text-sm" data-testid="provider-status">
            {provider ? (
              <>
                <Badge tone={provider.mode === "LIVE" ? "success" : "warning"}>
                  {t(`onlinePayments.modes.${provider.mode}`)}
                </Badge>{" "}
                {t("onlinePayments.savedAt", {
                  date: format.dateTime(provider.updatedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: ctx.timeZone,
                  }),
                })}
              </>
            ) : (
              t("onlinePayments.notSet")
            )}
          </p>
          <ProviderForm
            action={savePaymentProviderAction.bind(null, orgSlug)}
            mode={provider?.mode}
          />
        </Card>
      </div>
    </>
  );
}
