import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { CategoryForm } from "@/components/inventory/forms";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { getCategory } from "@/modules/catalog/categories";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { categoryName } from "@/server/inventory-view";
import { setCategoryArchivedAction, updateCategoryAction } from "../../actions";

export default async function CategoryPage({
  params,
}: PageProps<"/o/[orgSlug]/catalog/categories/[categoryId]">) {
  const { orgSlug, categoryId } = await params;
  if (!isUuid(categoryId)) notFound();
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "catalog.manage")) notFound();
  const category = await notFoundOnAppError(getCategory(ctx, categoryId));
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const archived = category.archivedAt !== null;
  return (
    <>
      <PageHeader
        title={categoryName(category, locale)}
        description={category.code}
        actions={
          <>
            {archived ? <Badge tone="muted">{t("common.archived")}</Badge> : null}
            <LinkButton
              href={`/o/${orgSlug}/catalog/products?categoryId=${category.id}`}
              variant="secondary"
            >
              {t("nav.products")}
            </LinkButton>
          </>
        }
      />
      <div className="space-y-6">
        <Card>
          <CategoryForm
            action={updateCategoryAction.bind(null, orgSlug, category.id)}
            submitLabel={t("common.save")}
            defaults={{ code: category.code, name: category.name, nameAr: category.nameAr ?? "" }}
          />
        </Card>
        <Card>
          <p className="text-muted mb-3 text-sm">{t("catalog.categoryArchiveHint")}</p>
          <ConfirmActionButton
            action={setCategoryArchivedAction.bind(null, orgSlug, category.id, !archived)}
            label={archived ? t("common.restore") : t("common.archive")}
            variant={archived ? "secondary" : "danger"}
          />
        </Card>
      </div>
    </>
  );
}
