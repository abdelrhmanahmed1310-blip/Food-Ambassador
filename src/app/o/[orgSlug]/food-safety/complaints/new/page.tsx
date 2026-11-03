import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ComplaintForm } from "@/components/foodsafety/quality-forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { listProductOptions } from "@/modules/catalog/service";
import { branchOptions } from "@/modules/foodsafety/service";
import { businessDate } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { productOptions } from "@/server/inventory-view";
import { logComplaintAction } from "../../quality-actions";

export default async function NewComplaintPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/complaints/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.record")) notFound();
  const [t, locale, branches, products] = await Promise.all([
    getTranslations(),
    getLocale(),
    branchOptions(ctx, "foodsafety.record"),
    hasPermission(ctx.grants, "catalog.view") ? listProductOptions(ctx) : Promise.resolve([]),
  ]);
  return (
    <>
      <PageHeader title={t("complaints.newTitle")} description={t("complaints.hint")} />
      <Card>
        <ComplaintForm
          action={logComplaintAction.bind(null, orgSlug)}
          branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
          products={productOptions(products, locale)}
          today={businessDate(ctx.timeZone)}
        />
      </Card>
    </>
  );
}
