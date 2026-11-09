import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ActionForm, TextField } from "@/components/forms/fields";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listCategories, listSources } from "@/modules/nutrition/engine/foods";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { setCategoryArabicAction } from "../actions";
import { Tabs } from "../tabs";

/** Where nutrition data comes from, which source wins, and the food categories (ADR-132). */
export default async function SourcesPage({ params }: PageProps<"/o/[orgSlug]/nutrition/sources">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "nutrition.view")) notFound();
  const [t, locale, s, categories] = await Promise.all([
    getTranslations("nutritionEngine"),
    getLocale(),
    listSources(ctx),
    listCategories(ctx),
  ]);
  const manage = hasPermission(ctx.grants, "nutrition.manage");
  return (
    <>
      <PageHeader title={t("sourcesTitle")} description={t("sourcesIntro")} />
      <Tabs orgSlug={orgSlug} current="sources" />
      <div className="space-y-6">
        <Card title={t("priority")}>
          <ol className="list-decimal space-y-1 ps-6 text-sm" data-testid="source-priority">
            {s.priority.map((p) => (
              <li key={p.key}>{t(`priorityItems.${p.key as "MANUAL"}`)}</li>
            ))}
          </ol>
          <p className="text-muted mt-3 text-xs">{t("priorityNote")}</p>
        </Card>
        <Card title={t("libraryBySource")}>
          {s.library.length === 0 ? (
            <EmptyState title={t("noFoods")} />
          ) : (
            <Table label={t("libraryBySource")}>
              <thead>
                <tr>
                  <Th>{t("source")}</Th>
                  <Th>{t("dataType")}</Th>
                  <Th>{t("records")}</Th>
                  <Th>{t("verified")}</Th>
                </tr>
              </thead>
              <tbody>
                {s.library.map((r) => (
                  <tr key={`${r.source}:${r.dataType}`}>
                    <Td>{t(`sources.${r.source as "MANUAL"}`)}</Td>
                    <Td className="ltr-value">{r.dataType ?? "—"}</Td>
                    <Td className="ltr-value tabular-nums">{r.records}</Td>
                    <Td className="ltr-value tabular-nums">{r.verified}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title={t("productProfiles")}>
          {s.productProfiles.length === 0 ? (
            <EmptyState title={t("noProfiles")} />
          ) : (
            <Table label={t("productProfiles")}>
              <thead>
                <tr>
                  <Th>{t("source")}</Th>
                  <Th>{t("records")}</Th>
                  <Th>{t("verified")}</Th>
                </tr>
              </thead>
              <tbody>
                {s.productProfiles.map((r) => (
                  <tr key={r.source}>
                    <Td>{t(`profileSources.${r.source as "LAB"}`)}</Td>
                    <Td className="ltr-value tabular-nums">{r.profiles}</Td>
                    <Td className="ltr-value tabular-nums">{r.verified}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title={t("categories")}>
          {categories.length === 0 ? (
            <EmptyState title={t("noCategories")} />
          ) : (
            <Table label={t("categories")}>
              <thead>
                <tr>
                  <Th>{t("nameEn")}</Th>
                  <Th>{t("nameAr")}</Th>
                  <Th>{t("records")}</Th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <bdi>{c.name}</bdi>
                    </Td>
                    <Td>
                      {manage ? (
                        <ActionForm
                          action={setCategoryArabicAction.bind(null, orgSlug, c.id)}
                          submitLabel={t("save")}
                          submitVariant="secondary"
                          className="flex items-end gap-2"
                        >
                          <TextField
                            name="nameAr"
                            label={t("nameAr")}
                            defaultValue={c.nameAr ?? ""}
                            dir="rtl"
                          />
                        </ActionForm>
                      ) : (
                        <span dir="rtl">{c.nameAr ?? "—"}</span>
                      )}
                    </Td>
                    <Td className="ltr-value tabular-nums">{c.foods}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {locale === "ar" ? (
            <p className="text-muted mt-2 text-xs">{t("arabicReviewNote")}</p>
          ) : null}
        </Card>
      </div>
    </>
  );
}
