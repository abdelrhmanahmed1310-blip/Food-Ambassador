import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ProductForm } from "@/components/inventory/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listCategories } from "@/modules/catalog/categories";
import { listUnits } from "@/modules/catalog/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { categoryOptions, unitOptions } from "@/server/inventory-view";
import { createProductAction } from "../../actions";

export default async function NewProductPage({
  params,
}: PageProps<"/o/[orgSlug]/catalog/products/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "catalog.manage")) notFound();
  const [t, locale, units, categories] = await Promise.all([
    getTranslations(),
    getLocale(),
    listUnits(ctx),
    listCategories(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("catalog.newProductTitle")} />
      <Card>
        <ProductForm
          action={createProductAction.bind(null, orgSlug)}
          units={unitOptions(units, locale)}
          categories={categoryOptions(categories, locale)}
          submitLabel={t("common.create")}
          idempotent
        />
      </Card>
    </>
  );
}
