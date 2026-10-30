import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CategoryForm } from "@/components/inventory/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listCategories } from "@/modules/catalog/categories";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { categoryName } from "@/server/inventory-view";
import { createCategoryAction } from "../actions";

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
                <Th>{t("nav.products")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{c.code}</span>
                  </Td>
                  <Td>
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
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
