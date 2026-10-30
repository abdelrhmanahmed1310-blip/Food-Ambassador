import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { LibraryImportForm } from "@/components/nutrition/library-forms";
import { Pagination } from "@/components/ui/pagination";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listLibraryImports, listReferenceFoods } from "@/modules/nutrition/library";
import {
  LIBRARY_SOURCES,
  SOURCE_TERMS,
  type LibrarySource,
} from "@/modules/nutrition/library-parsers";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { quantityFormatter } from "@/server/inventory-view";
import { importLibraryAction } from "./actions";

export default async function LibraryPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/catalog/library">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "nutrition.view")) notFound();
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : undefined;
  const source = LIBRARY_SOURCES.find((s) => s === sp.source) as LibrarySource | undefined;
  const page = pageSchema.parse(sp.page);
  const [t, locale, format, fmt, result, imports] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    listReferenceFoods(ctx, { q, source, page }),
    listLibraryImports(ctx),
  ]);
  const base = `/o/${orgSlug}/catalog/library`;
  const sources = LIBRARY_SOURCES.map((s) => ({ value: s, label: t(`library.sources.${s}`) }));
  return (
    <>
      <PageHeader title={t("library.title")} description={t("library.hint")} />
      <div className="space-y-6">
        <Alert tone="info">{t("library.notVerifiedNote")}</Alert>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("library.search")}</span>
            <input
              name="q"
              defaultValue={q}
              className="border-border bg-surface rounded-md border px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("library.source")}</span>
            <select
              name="source"
              defaultValue={source ?? ""}
              className="border-border bg-surface rounded-md border px-3 py-2"
            >
              <option value="">{t("library.allSources")}</option>
              {sources.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
          >
            {t("common.apply")}
          </button>
        </form>
        {result.total === 0 ? (
          <EmptyState title={t("library.none")} />
        ) : (
          <Table label={t("library.title")}>
            <thead>
              <tr>
                <Th>{t("library.name")}</Th>
                <Th>{t("library.source")}</Th>
                <Th>{t("nutrition.nutrients.energyKcal")}</Th>
                <Th>{t("nutrition.allergens")}</Th>
                <Th>{t("library.linkedTo")}</Th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((f) => (
                <tr key={f.id} data-testid={`library-${f.sourceId}`}>
                  <Td>
                    <Link href={`${base}/${f.id}`} className="text-primary hover:underline">
                      <bdi>{(locale === "ar" && f.nameAr) || f.name}</bdi>
                    </Link>
                    {f.brand ? (
                      <span className="text-muted block text-xs">
                        <bdi>{f.brand}</bdi>
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-xs">
                    {t(`library.sources.${f.source}`)}
                    <span className="ltr-value text-muted block font-mono">
                      {f.sourceId}
                      {f.dataType ? ` · ${f.dataType}` : ""}
                    </span>
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value">{f.energyKcal ? fmt(f.energyKcal) : "—"}</span>
                  </Td>
                  <Td className="text-xs">
                    {f.allergens
                      .map((a) => t(`nutrition.allergenNames.${a as "MILK"}`))
                      .join(", ") || "—"}
                  </Td>
                  <Td className="text-xs">
                    {f.linkedProduct ? (
                      <Link
                        href={`/o/${orgSlug}/catalog/products/${f.linkedProduct.id}/nutrition`}
                        className="ltr-value text-primary font-mono hover:underline"
                      >
                        {f.linkedProduct.sku}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination
          basePath={base}
          params={{ q, source }}
          page={result.page}
          pageCount={result.pageCount}
          total={result.total}
        />

        {hasPermission(ctx.grants, "nutrition.manage") ? (
          <Card title={t("library.importTitle")}>
            <div className="mb-4 space-y-2 text-sm">
              <p className="text-muted">{t("library.importHint")}</p>
              <ul className="list-disc space-y-1 ps-5">
                {LIBRARY_SOURCES.map((s) => (
                  <li key={s}>
                    <strong>{t(`library.sources.${s}`)}:</strong> {t(`library.formats.${s}`)}{" "}
                    <span className="text-muted">({SOURCE_TERMS[s].licence})</span>
                  </li>
                ))}
              </ul>
              <p className="text-muted">{t("library.largeFiles")}</p>
            </div>
            <LibraryImportForm action={importLibraryAction.bind(null, orgSlug)} sources={sources} />
          </Card>
        ) : null}

        {imports.length > 0 ? (
          <Card title={t("library.imports")}>
            <ul className="space-y-1 text-sm">
              {imports.map((i) => (
                <li key={i.id}>
                  {format.dateTime(i.createdAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: ctx.timeZone,
                  })}{" "}
                  · {t(`library.sources.${i.source}`)} · <bdi>{i.fileName}</bdi> ·{" "}
                  {t("library.importCounts", {
                    created: i.created,
                    updated: i.updated,
                    skipped: i.skipped,
                  })}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
