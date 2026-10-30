import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { PrintButton } from "@/components/ui/print-button";
import { hasPermission } from "@/modules/access/authorize";
import { ALLERGEN_CODES } from "@/modules/nutrition/allergens";
import { allergenMatrix } from "@/modules/nutrition/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const MARK = { CONTAINS: "●", MAY_CONTAIN: "◐", FREE_FROM: "–", UNKNOWN: "?" } as const;
const TONE = {
  CONTAINS: "text-danger font-semibold",
  MAY_CONTAIN: "text-warning font-semibold",
  FREE_FROM: "text-muted",
  UNKNOWN: "text-muted",
} as const;

export default async function AllergenMatrixPage({
  params,
}: PageProps<"/o/[orgSlug]/recipes/allergens">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "nutrition.view") || !hasPermission(ctx.grants, "recipes.view"))
    notFound();
  const [t, locale, rows] = await Promise.all([
    getTranslations(),
    getLocale(),
    allergenMatrix(ctx),
  ]);
  return (
    <>
      <PageHeader
        title={t("nutrition.matrixTitle")}
        description={t("nutrition.matrixHint")}
        actions={
          <span className="print:hidden">
            <PrintButton label={t("recipes.print")} />
          </span>
        }
      />
      <div className="space-y-4">
        <p className="text-sm">
          {(["CONTAINS", "MAY_CONTAIN", "FREE_FROM", "UNKNOWN"] as const).map((s) => (
            <span key={s} className="me-4 inline-block">
              <span className={TONE[s]}>{MARK[s]}</span> {t(`nutrition.statements.${s}`)}
            </span>
          ))}
        </p>
        <Alert tone="info">{t("nutrition.matrixNote")}</Alert>
        {rows.length === 0 ? (
          <EmptyState title={t("nutrition.noActiveRecipes")} />
        ) : (
          <Table label={t("nutrition.matrixTitle")}>
            <thead>
              <tr>
                <Th>{t("nutrition.recipe")}</Th>
                {ALLERGEN_CODES.map((c) => (
                  <Th key={c}>
                    <span className="text-xs">{t(`nutrition.allergenShort.${c}`)}</span>
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.recipe.id} data-testid={`matrix-${r.recipe.code}`}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/recipes/${r.recipe.id}/nutrition`}
                      className="text-primary hover:underline"
                    >
                      <span className="ltr-value font-mono text-xs">{r.recipe.code}</span>{" "}
                      <bdi>{(locale === "ar" && r.recipe.nameAr) || r.recipe.name}</bdi>
                    </Link>
                  </Td>
                  {ALLERGEN_CODES.map((c) => {
                    const s = r.allergens[c].status;
                    return (
                      <Td key={c} className="text-center">
                        <span
                          className={TONE[s]}
                          title={t(`nutrition.statements.${s}`)}
                          data-status={s}
                        >
                          {MARK[s]}
                        </span>
                      </Td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
