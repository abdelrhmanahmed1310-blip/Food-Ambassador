import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
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
import { listRecipes } from "@/modules/recipes/recipes";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { quantityFormatter } from "@/server/inventory-view";

export default async function RecipesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/recipes">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "recipes.view")) notFound();
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : undefined;
  const type = sp.type === "DISH" || sp.type === "PREPARATION" ? sp.type : undefined;
  const archived = sp.archived === "1";
  const page = pageSchema.parse(sp.page);
  const [t, locale, fmt, result] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    listRecipes(ctx, { q, type, archived, page }),
  ]);
  const base = `/o/${orgSlug}/recipes`;
  return (
    <>
      <PageHeader
        title={t("recipes.title")}
        description={t("recipes.hint")}
        actions={
          hasPermission(ctx.grants, "recipes.manage") ? (
            <LinkButton href={`${base}/new`}>{t("recipes.new")}</LinkButton>
          ) : null
        }
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3" role="search">
        <label className="text-sm">
          <span className="mb-1 block font-medium">{t("common.search")}</span>
          <input
            name="q"
            defaultValue={q}
            className="border-border bg-surface rounded-md border px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">{t("recipes.type")}</span>
          <select
            name="type"
            defaultValue={type ?? ""}
            className="border-border bg-surface rounded-md border px-3 py-2"
          >
            <option value="">{t("common.all")}</option>
            <option value="DISH">{t("recipes.types.DISH")}</option>
            <option value="PREPARATION">{t("recipes.types.PREPARATION")}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="archived" value="1" defaultChecked={archived} />
          {t("common.archived")}
        </label>
        <button
          type="submit"
          className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
        >
          {t("common.apply")}
        </button>
      </form>
      {result.total === 0 ? (
        <EmptyState title={t("recipes.empty")} />
      ) : (
        <Table label={t("recipes.title")}>
          <thead>
            <tr>
              <Th>{t("recipes.code")}</Th>
              <Th>{t("recipes.name")}</Th>
              <Th>{t("recipes.type")}</Th>
              <Th>{t("recipes.activeVersion")}</Th>
              <Th>{t("recipes.yield")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((r) => {
              const active = r.versions.find((v) => v.status === "ACTIVE");
              const draft = r.versions.find((v) => v.status === "DRAFT");
              const shown = active ?? draft;
              return (
                <tr key={r.id}>
                  <Td>
                    <Link
                      href={`${base}/${r.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {r.code}
                    </Link>
                  </Td>
                  <Td>{(locale === "ar" && r.nameAr) || r.name}</Td>
                  <Td>{t(`recipes.types.${r.type}`)}</Td>
                  <Td>
                    {active ? t("recipes.versionNo", { no: active.versionNo }) : "—"}
                    {draft ? (
                      <span className="ms-2">
                        <Badge tone="neutral">{t("recipes.draftOpen")}</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">
                    {shown ? (
                      <span className="ltr-value whitespace-nowrap">
                        {fmt(shown.yieldQuantity)} {shown.yieldUom.code}
                        {shown.portions
                          ? ` · ${t("recipes.portionsCount", { count: fmt(shown.portions) })}`
                          : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <Pagination
        basePath={base}
        params={{ q, type, archived: archived ? "1" : undefined }}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
