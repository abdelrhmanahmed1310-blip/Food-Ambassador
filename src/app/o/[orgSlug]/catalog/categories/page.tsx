import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CategoryForm, ImportForm } from "@/components/inventory/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listCategories } from "@/modules/catalog/categories";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { MAX_CATEGORY_DEPTH } from "@/modules/catalog/category-tree";
import { categoryName, categoryOptions } from "@/server/inventory-view";
import { createCategoryAction, importCategoriesAction } from "../actions";

export default async function CategoriesPage({
  params,
}: PageProps<"/o/[orgSlug]/catalog/categories">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "catalog.view")) notFound();
  const [t, locale, categories] = await Promise.all([
    getTranslations(),
    getLocale(),
    listCategories(ctx, { includeArchived: true }),
  ]);
  const canManage = hasPermission(ctx.grants, "catalog.manage");
  const base = `/o/${orgSlug}/catalog`;
  return (
    <>
      <PageHeader title={t("catalog.categoriesTitle")} description={t("catalog.categoriesHint")} />
      <div className="space-y-6">
        {categories.length === 0 ? (
          <EmptyState title={t("catalog.noCategories")} />
        ) : (
          <Table label={t("catalog.categoriesTitle")}>
            <thead>
              <tr>
                <Th>{t("catalog.categoryCode")}</Th>
                <Th>{t("catalog.categoryName")}</Th>
                <Th>{t("catalog.subcategories")}</Th>
                <Th>{t("nav.products")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id} data-testid={`category-${c.code}`}>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{c.code}</span>
                  </Td>
                  <Td>
                    {/* Indented under its parent (ADR-134). */}
                    <span
                      style={{ paddingInlineStart: `${c.depth * 1.25}rem` }}
                      className="inline-block"
                    >
                      {c.depth > 0 ? (
                        <span className="text-muted me-1" aria-hidden="true">
                          ↳
                        </span>
                      ) : null}
                      {canManage ? (
                        <Link
                          href={`${base}/categories/${c.id}`}
                          className="text-primary font-medium hover:underline"
                        >
                          {categoryName(c, locale)}
                        </Link>
                      ) : (
                        categoryName(c, locale)
                      )}
                    </span>
                  </Td>
                  <Td className="tabular-nums">
                    {categories.filter((x) => x.parentId === c.id).length || "—"}
                  </Td>
                  <Td className="tabular-nums">
                    <Link
                      href={`${base}/products?categoryId=${c.id}`}
                      className="text-primary hover:underline"
                    >
                      {c._count.products}
                    </Link>
                  </Td>
                  <Td>
                    {c.archivedAt ? (
                      <Badge tone="muted">{t("common.archived")}</Badge>
                    ) : (
                      <Badge tone="success">{t("common.active")}</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {canManage ? (
          <Card title={t("catalog.newCategory")}>
            <CategoryForm
              action={createCategoryAction.bind(null, orgSlug)}
              submitLabel={t("common.create")}
              parents={categoryOptions(
                categories.filter((c) => !c.archivedAt && c.depth < MAX_CATEGORY_DEPTH - 1),
                locale,
              )}
            />
          </Card>
        ) : null}
        {canManage ? (
          <ImportForm
            action={importCategoriesAction.bind(null, orgSlug)}
            title={t("import.categoriesTitle")}
            hint={t("import.categoriesHint")}
            templateHref={`/o/${orgSlug}/catalog/import/template?kind=categories`}
          />
        ) : null}
      </div>
    </>
  );
}
