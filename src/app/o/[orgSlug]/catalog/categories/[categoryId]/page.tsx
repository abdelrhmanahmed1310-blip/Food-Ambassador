import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { CategoryForm } from "@/components/inventory/forms";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { getCategory, listCategories } from "@/modules/catalog/categories";
import { descendants, MAX_CATEGORY_DEPTH } from "@/modules/catalog/category-tree";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { categoryName, categoryOptions } from "@/server/inventory-view";
import { setCategoryArchivedAction, updateCategoryAction } from "../../actions";

export default async function CategoryPage({
  params,
}: PageProps<"/o/[orgSlug]/catalog/categories/[categoryId]">) {
  const { orgSlug, categoryId } = await params;
  if (!isUuid(categoryId)) notFound();
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "catalog.manage")) notFound();
  const category = await notFoundOnAppError(getCategory(ctx, categoryId));
  const [t, locale, all] = await Promise.all([getTranslations(), getLocale(), listCategories(ctx)]);
  // It may go under any active category but itself and its own subcategories (ADR-134).
  const own = new Set([category.id, ...descendants(category.id, all)]);
  const parents = categoryOptions(
    all.filter((c) => !own.has(c.id) && c.depth < MAX_CATEGORY_DEPTH - 1),
    locale,
  );
  const archived = category.archivedAt !== null;
  return (
    <>
      <PageHeader
        title={categoryName(category, locale)}
        description={
          category.parent
            ? `${category.code} · ${t("catalog.underParent", { parent: categoryName(category.parent, locale) })}`
            : category.code
        }
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
            defaults={{
              code: category.code,
              name: category.name,
              nameAr: category.nameAr ?? "",
              parentId: category.parentId ?? "",
            }}
            parents={parents}
          />
        </Card>
        {category.subcategories.length > 0 ? (
          <Card title={t("catalog.subcategories")}>
            <ul className="space-y-1 text-sm">
              {category.subcategories.map((s) => (
                <li key={s.id}>
                  <a
                    href={`/o/${orgSlug}/catalog/categories/${s.id}`}
                    className="text-primary hover:underline"
                  >
                    <span className="ltr-value font-mono text-xs">{s.code}</span> —{" "}
                    {categoryName(s, locale)}
                  </a>
                  {s.archivedAt ? (
                    <span className="text-muted ms-2 text-xs">{t("common.archived")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
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
