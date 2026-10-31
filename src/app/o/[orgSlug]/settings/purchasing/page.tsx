import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AccountsForm } from "@/components/invoices/payables-forms";
import { ProcurementSettingsForm } from "@/components/procurement/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { getAccountingSettings } from "@/modules/invoices/accounting";
import { getProcurementSettings } from "@/modules/procurement/settings";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { updateProcurementSettingsAction } from "../../purchasing/actions";
import { updateAccountingSettingsAction } from "../../purchasing/payables/actions";

export default async function PurchasingSettingsPage({
  params,
}: PageProps<"/o/[orgSlug]/settings/purchasing">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, rules, accounts] = await Promise.all([
    getTranslations(),
    getProcurementSettings(ctx),
    getAccountingSettings(ctx),
  ]);
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
            invoicePriceTolerancePercent: rules.invoicePriceTolerance.times(100).toFixed(),
            branchApprovalSteps: String(rules.branchApprovalSteps),
            headOfficeApproval: String(rules.headOfficeApproval),
          }}
        />
      </Card>
      <div className="mt-6">
        <Card title={t("payables.accountsTitle")}>
          <AccountsForm
            action={updateAccountingSettingsAction.bind(null, orgSlug)}
            defaults={{
              payablesAccount: accounts?.payablesAccount ?? "",
              purchasesAccount: accounts?.purchasesAccount ?? "",
              inputVatAccount: accounts?.inputVatAccount ?? "",
              paymentsAccount: accounts?.paymentsAccount ?? "",
            }}
          />
        </Card>
      </div>
    </>
  );
}
