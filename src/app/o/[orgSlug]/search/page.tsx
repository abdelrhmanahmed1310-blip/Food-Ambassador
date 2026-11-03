import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { inputClass, buttonClass } from "@/components/ui/styles";
import { MIN_QUERY } from "@/modules/search/rules";
import { globalSearch } from "@/modules/search/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** One box for master data and documents, within the user's permissions (ADR-088). */
export default async function SearchPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/search">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const raw = typeof sp.q === "string" ? sp.q : "";
  const [t, locale, result] = await Promise.all([
    getTranslations("search"),
    getLocale(),
    globalSearch(ctx, raw),
  ]);
  const base = `/o/${orgSlug}`;
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="space-y-6">
        <form method="get" role="search" className="flex flex-wrap gap-2">
          <label htmlFor="search-page-q" className="sr-only">
            {t("label")}
          </label>
          <input
            id="search-page-q"
            name="q"
            type="search"
            defaultValue={raw}
            minLength={MIN_QUERY}
            maxLength={80}
            placeholder={t("placeholder")}
            className={`${inputClass} max-w-xl flex-1`}
            autoFocus
          />
          <button type="submit" className={buttonClass("primary")}>
            {t("submit")}
          </button>
        </form>
        {!result.query ? (
          <p className="text-muted text-sm">{t("hint", { min: MIN_QUERY })}</p>
        ) : result.groups.length === 0 ? (
          <EmptyState title={t("none", { query: result.query })} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2" data-testid="search-results">
            {result.groups.map((g) => (
              <Card key={g.group} title={t(`groups.${g.group}`)}>
                <ul className="divide-border divide-y" data-testid={`search-${g.group}`}>
                  {g.hits.map((h) => (
                    <li key={h.id} className="py-2">
                      <Link href={`${base}${h.href}`} className="text-primary hover:underline">
                        <span className="ltr-value font-mono text-xs">{h.code}</span>{" "}
                        <bdi>{(locale === "ar" && h.titleAr) || h.title}</bdi>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
