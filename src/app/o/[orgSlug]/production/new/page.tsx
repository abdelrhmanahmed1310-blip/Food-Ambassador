import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ProductionOrderForm } from "@/components/production/forms";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { warehouseOptions } from "@/modules/inventory/queries";
import { producibleRecipes } from "@/modules/production/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createProductionOrderAction } from "../actions";

export default async function NewProductionPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/production/new">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "production.manage")) notFound();
  const [t, locale, recipes, warehouses] = await Promise.all([
    getTranslations(),
    getLocale(),
    producibleRecipes(ctx),
    warehouseOptions(ctx, "production.manage"),
  ]);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return (
    <>
      <PageHeader title={t("production.new")} description={t("production.newHint")} />
      <Card>
        {recipes.length === 0 ? (
          <EmptyState title={t("production.noRecipes")} />
        ) : (
          <ProductionOrderForm
            action={createProductionOrderAction.bind(null, orgSlug)}
            recipes={recipes.map((r) => ({
              value: r.id,
              label: `${r.code} — ${(locale === "ar" && r.nameAr) || r.name} (${t(
                "production.batchOf",
                {
                  quantity: r.versions[0].yieldQuantity.toString(),
                  unit: r.versions[0].yieldUom.code,
                },
              )})`,
            }))}
            warehouses={warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
            defaults={{
              recipeId: isUuid(str(sp.recipeId)) ? str(sp.recipeId) : undefined,
              warehouseId: isUuid(str(sp.warehouseId)) ? str(sp.warehouseId) : undefined,
              plannedQuantity: /^\d+(\.\d+)?$/.test(str(sp.quantity) ?? "")
                ? str(sp.quantity)
                : undefined,
            }}
          />
        )}
      </Card>
    </>
  );
}
