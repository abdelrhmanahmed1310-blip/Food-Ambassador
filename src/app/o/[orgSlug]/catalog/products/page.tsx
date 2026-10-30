import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ListFilters } from "@/components/ui/list-filters";
import { Pagination } from "@/components/ui/pagination";
import {
  Badge,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listProducts } from "@/modules/catalog/service";
import { pageSchema } from "@/modules/shared/schemas";
import { listStatusSchema } from "@/modules/sites/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { categoryName, categoryOptions, productName } from "@/server/inventory-view";
import { listCategories } from "@/modules/catalog/categories";
import { isUuid } from "@/lib/uuid";

export default async function ProductsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/catalog/products">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "catalog.view")) notFound();
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = listStatusSchema.parse(sp.status);
  const page = pageSchema.parse(sp.page);
  const categoryId =
    typeof sp.categoryId === "string" && isUuid(sp.categoryId) ? sp.categoryId : undefined;
  const [t, locale, result, categories] = await Promise.all([
    getTranslations(),
    getLocale(),
    listProducts(ctx, { q, status, categoryId, page }),
    listCategories(ctx, { includeArchived: true }),
  ]);
  const canManage = hasPermission(ctx.grants, "catalog.manage");
  const base = `/o/${orgSlug}/catalog/products`;
  const newButton = canManage ? (
    <LinkButton href={`${base}/new`}>{t("catalog.newProduct")}</LinkButton>
  ) : undefined;

  return (
    <>
      <PageHeader
        title={t("catalog.productsTitle")}
        actions={
          <>
            <LinkButton href={`${base}/export`} variant="secondary">
              {t("catalog.exportProducts")}
            </LinkButton>
            {canManage ? (
              <LinkButton href={`/o/${orgSlug}/catalog/import`} variant="secondary">
                {t("nav.import")}
              </LinkButton>
            ) : null}
            {newButton}
          </>
        }
      />
      <ListFilters
        q={q}
        status={status}
        extra={
          categories.length > 0
            ? {
                name: "categoryId",
                label: t("catalog.allCategories"),
                value: categoryId,
                options: categoryOptions(categories, locale),
              }
            : undefined
        }
      />
      {result.total === 0 && !q && status === "active" ? (
        <EmptyState
          title={t("catalog.emptyProducts")}
          hint={t("catalog.emptyProductsHint")}
          action={newButton}
        />
      ) : result.items.length === 0 ? (
        <EmptyState title={t("common.noResults")} />
      ) : (
        <Table label={t("catalog.productsTitle")}>
          <thead>
            <tr>
              <Th>{t("catalog.sku")}</Th>
              <Th>{t("branches.name")}</Th>
              <Th>{t("catalog.type")}</Th>
              <Th>{t("catalog.category")}</Th>
              <Th>{t("catalog.baseUnit")}</Th>
              <Th>{t("catalog.lotTracking")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((p) => (
              <tr key={p.id}>
                <Td>
                  <span className="ltr-value font-mono text-xs">{p.sku}</span>
                </Td>
                <Td>
                  <Link
                    href={`${base}/${p.id}`}
                    className="text-primary font-medium hover:underline"
                  >
                    {productName(p, locale)}
                  </Link>
                </Td>
                <Td>{t(`catalog.types.${p.type}`)}</Td>
                <Td>{p.category ? categoryName(p.category, locale) : "—"}</Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{p.baseUom.code}</span>
                </Td>
                <Td>{t(`catalog.lotModes.${p.lotTracking}`)}</Td>
                <Td>
                  {p.archivedAt ? (
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
      <Pagination
        basePath={base}
        params={{ q, categoryId, status: status === "active" ? undefined : status }}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
