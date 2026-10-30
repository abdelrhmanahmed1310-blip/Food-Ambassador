import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { NewRecipeForm } from "@/components/recipes/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listUnits } from "@/modules/catalog/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { unitOptions } from "@/server/inventory-view";
import { createRecipeAction } from "../actions";

export default async function NewRecipePage({ params }: PageProps<"/o/[orgSlug]/recipes/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "recipes.manage")) notFound();
  const [t, locale, units] = await Promise.all([getTranslations(), getLocale(), listUnits(ctx)]);
  return (
    <>
      <PageHeader title={t("recipes.newTitle")} description={t("recipes.newHint")} />
      <Card>
        <NewRecipeForm
          action={createRecipeAction.bind(null, orgSlug)}
          units={unitOptions(
            units.filter((u) => u.factorToBase !== null),
            locale,
          )}
        />
      </Card>
    </>
  );
}
