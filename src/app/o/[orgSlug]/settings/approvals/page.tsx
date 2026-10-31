import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ApprovalMatrixForm } from "@/components/approvals/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import type { ApprovalLayer } from "@/modules/approvals/rules";
import { getApprovalMatrix } from "@/modules/approvals/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { updateApprovalMatrixAction } from "./actions";

const defaults = (layers: ApprovalLayer[]) =>
  Object.fromEntries(
    ([1, 2, 3, 4] as const).map((p) => [
      p,
      layers.find((l) => l.position === p)?.aboveAmount.toFixed() ?? "",
    ]),
  ) as Record<1 | 2 | 3 | 4, string>;

export default async function ApprovalsSettingsPage({
  params,
}: PageProps<"/o/[orgSlug]/settings/approvals">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, matrix] = await Promise.all([getTranslations(), getApprovalMatrix(ctx)]);
  return (
    <>
      <PageHeader title={t("approvals.title")} description={t("approvals.intro")} />
      <Card title={t("approvals.purchaseOrders")}>
        <ApprovalMatrixForm
          action={updateApprovalMatrixAction.bind(null, orgSlug, "PURCHASE_ORDER")}
          currency={ctx.baseCurrency}
          defaults={defaults(matrix.PURCHASE_ORDER)}
          amountHint={t("approvals.purchaseOrdersHint")}
        />
      </Card>
      <div className="mt-6">
        <Card title={t("approvals.stockCounts")}>
          <ApprovalMatrixForm
            action={updateApprovalMatrixAction.bind(null, orgSlug, "STOCK_COUNT")}
            currency={ctx.baseCurrency}
            defaults={defaults(matrix.STOCK_COUNT)}
            amountHint={t("approvals.stockCountsHint")}
          />
        </Card>
      </div>
    </>
  );
}
