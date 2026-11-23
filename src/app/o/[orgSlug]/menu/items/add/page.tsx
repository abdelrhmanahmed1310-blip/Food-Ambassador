import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { AddToMenuForm } from "@/components/menu/add-to-menu-form";
import { Alert, EmptyState, PageHeader } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { hasPermission } from "@/modules/access/authorize";
import { CANDIDATE_LIMIT, menuCandidates, PRODUCT_TYPES } from "@/modules/menu/bulk";
import { SALES_CHANNELS } from "@/modules/menu/rules";
import { menuFormOptions } from "@/modules/menu/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { addToMenuAction } from "../../actions";

/** Put any products (every type) and dishes on the menu at once (ADR-138). */
export default async function AddToMenuPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/menu/items/add">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "menu.manage")) notFound();
  const [t, tCat, tMenu, locale, options, data] = await Promise.all([
    getTranslations("menuBulk"),
    getTranslations("catalog"),
    getTranslations("menu"),
    getLocale(),
    menuFormOptions(ctx),
    menuCandidates(ctx, sp),
  ]);
  const typeLabel = (type: string) =>
    type === "DISH" ? t("dish") : tCat(`types.${type as "RAW_MATERIAL"}`);
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("intro")}
        actions={
          <Link href={`/o/${orgSlug}/menu`} className="text-primary text-sm hover:underline">
            {t("back")}
          </Link>
        }
      />
      <div className="space-y-6">
        <Alert tone="info">{t("howItSells")}</Alert>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm" htmlFor="add-q">
            <span className="mb-1 block font-medium">{t("search")}</span>
            <input
              id="add-q"
              name="q"
              defaultValue={data.filter.q ?? ""}
              className={`${inputClass} w-64`}
            />
          </label>
          <label className="text-sm" htmlFor="add-type">
            <span className="mb-1 block font-medium">{t("type")}</span>
            <select
              id="add-type"
              name="type"
              defaultValue={data.filter.type}
              className={inputClass}
            >
              <option value="ALL">{t("allTypes")}</option>
              {[...PRODUCT_TYPES, "DISH" as const].map((k) => (
                <option key={k} value={k}>
                  {typeLabel(k)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            {t("show")}
          </button>
        </form>
        {options.categories.length === 0 ? (
          <EmptyState title={tMenu("noCategories")} hint={tMenu("noCategoriesHint")} />
        ) : data.rows.length === 0 ? (
          <EmptyState title={t("nothingFound")} />
        ) : (
          <>
            {data.rows.length >= CANDIDATE_LIMIT ? (
              <p className="text-muted text-sm">{t("limited", { count: CANDIDATE_LIMIT })}</p>
            ) : null}
            <AddToMenuForm
              action={addToMenuAction.bind(null, orgSlug)}
              rows={data.rows.map((r) => ({
                key: `${r.source}:${r.id}`,
                code: r.code,
                name: (locale === "ar" && r.nameAr) || r.name,
                type: typeLabel(r.type),
                detail: [
                  r.unit ? t("perUnit", { unit: r.unit }) : null,
                  r.barcode ? t("barcode", { code: r.barcode }) : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
                onMenu: r.onMenu,
              }))}
              categories={options.categories.map((c) => ({
                value: c.id,
                label: (locale === "ar" && c.nameAr) || c.name,
              }))}
              channels={SALES_CHANNELS.map((c) => ({ value: c, label: tMenu(`channels.${c}`) }))}
              branches={options.branches.map((b) => ({
                value: b.id,
                label: `${b.code} — ${b.name}`,
              }))}
              labels={{
                submit: t("submit"),
                pending: t("adding"),
                category: tMenu("category"),
                channels: t("channels"),
                branch: tMenu("branch"),
                allBranches: tMenu("allBranches"),
                selectAll: t("selectAll"),
                price: t("price"),
                onMenu: t("onMenu"),
                item: t("item"),
                type: t("type"),
                choose: t("chooseCategory"),
              }}
            />
          </>
        )}
      </div>
    </>
  );
}
