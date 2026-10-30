import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { AllergenStatusBadge, LabelStatusBadge } from "@/components/nutrition/badges";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { ALLERGEN_CODES } from "@/modules/nutrition/allergens";
import { NUTRIENTS } from "@/modules/nutrition/rules";
import { listLabels, recipeNutrition } from "@/modules/nutrition/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName, quantityFormatter } from "@/server/inventory-view";
import { generateLabelAction } from "../../nutrition-actions";

export default async function RecipeNutritionPage({
  params,
}: PageProps<"/o/[orgSlug]/recipes/[recipeId]/nutrition">) {
  const { orgSlug, recipeId } = await params;
  if (!isUuid(recipeId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const r = await notFoundOnAppError(recipeNutrition(ctx, recipeId));
  const [t, locale, format, fmt, labels] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    listLabels(ctx, recipeId),
  ]);
  const name = (id: string) => {
    const p = r.names.get(id);
    return p ? `${p.sku} — ${productName(p, locale)}` : id;
  };
  const productLink = (id: string) => (
    <Link
      key={id}
      href={`/o/${orgSlug}/catalog/products/${id}/nutrition`}
      className="text-primary hover:underline"
    >
      <bdi>{name(id)}</bdi>
    </Link>
  );
  const value = (v: Decimal | null | undefined) =>
    v === null || v === undefined ? (
      <span className="text-muted">{t("nutrition.unknown")}</span>
    ) : (
      <span className="ltr-value">{fmt(v.toDecimalPlaces(2))}</span>
    );
  const c = r.calc;
  const blockerText = (b: { kind: string; detail?: string }) =>
    b.kind === "NUTRIENT_UNKNOWN"
      ? t("nutrition.blockers.NUTRIENT_UNKNOWN", {
          nutrient: t(`nutrition.nutrients.${b.detail as "fat"}`),
        })
      : b.kind === "ALLERGEN_UNKNOWN"
        ? t("nutrition.blockers.ALLERGEN_UNKNOWN", {
            allergen: t(`nutrition.allergenNames.${b.detail as "MILK"}`),
          })
        : t(`nutrition.blockers.${b.kind as "INCOMPLETE_RECIPE"}`);
  return (
    <>
      <PageHeader
        title={t("nutrition.recipeTitle", {
          name: `${r.recipe.code} — ${(locale === "ar" && r.recipe.nameAr) || r.recipe.name}`,
        })}
        description={r.active ? t("recipes.versionNo", { no: r.active.versionNo }) : undefined}
        actions={
          <Link
            href={`/o/${orgSlug}/recipes/${recipeId}`}
            className="text-primary text-sm hover:underline"
          >
            {t("common.back")}
          </Link>
        }
      />
      {!c ? (
        <EmptyState title={t("nutrition.noActiveVersion")} />
      ) : (
        <div className="space-y-6">
          <Alert tone="info">{t("nutrition.calculationNote")}</Alert>
          {c.incomplete ? (
            <Alert tone="error">{t("nutrition.blockers.INCOMPLETE_RECIPE")}</Alert>
          ) : null}
          <Card title={t("nutrition.values")}>
            <Table label={t("nutrition.values")}>
              <thead>
                <tr>
                  <Th>{t("nutrition.nutrient")}</Th>
                  {c.perPortion ? <Th>{t("nutrition.perPortion")}</Th> : null}
                  {c.per100 ? <Th>{t(`nutrition.bases.${c.per100Basis}`)}</Th> : null}
                  <Th>{t("nutrition.perBatch")}</Th>
                  <Th>{t("nutrition.missingFrom")}</Th>
                </tr>
              </thead>
              <tbody>
                {NUTRIENTS.map((n) => (
                  <tr key={n} data-testid={`recipe-nutrient-${n}`}>
                    <Td>{t(`nutrition.nutrients.${n}`)}</Td>
                    {c.perPortion ? (
                      <Td className="tabular-nums">{value(c.perPortion[n])}</Td>
                    ) : null}
                    {c.per100 ? <Td className="tabular-nums">{value(c.per100[n])}</Td> : null}
                    <Td className="tabular-nums">{value(c.nutrition.totals[n])}</Td>
                    <Td className="text-xs">
                      {c.nutrition.missing[n].length === 0 ? (
                        "—"
                      ) : (
                        <span className="flex flex-wrap gap-x-2">
                          {c.nutrition.missing[n].map(productLink)}
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {c.nutrition.noConversion.length > 0 ? (
              <p className="mt-3 text-sm">
                {t("nutrition.noConversion")}{" "}
                <span className="inline-flex flex-wrap gap-x-2">
                  {c.nutrition.noConversion.map(productLink)}
                </span>
              </p>
            ) : null}
            {c.nutrition.unverified.length > 0 ? (
              <p className="mt-2 text-sm">
                {t("nutrition.unverifiedValues")}{" "}
                <span className="inline-flex flex-wrap gap-x-2">
                  {c.nutrition.unverified.map(productLink)}
                </span>
              </p>
            ) : null}
          </Card>

          <Card title={t("nutrition.allergens")}>
            <Table label={t("nutrition.allergens")}>
              <thead>
                <tr>
                  <Th>{t("nutrition.allergen")}</Th>
                  <Th>{t("nutrition.statement")}</Th>
                  <Th>{t("nutrition.because")}</Th>
                </tr>
              </thead>
              <tbody>
                {ALLERGEN_CODES.map((code) => {
                  const a = c.allergens[code];
                  const ids =
                    a.status === "CONTAINS"
                      ? a.contains
                      : a.status === "MAY_CONTAIN"
                        ? a.mayContain
                        : a.unknown;
                  return (
                    <tr key={code} data-testid={`recipe-allergen-${code}`}>
                      <Td>{t(`nutrition.allergenNames.${code}`)}</Td>
                      <Td>
                        <AllergenStatusBadge status={a.status} />
                      </Td>
                      <Td className="text-xs">
                        {ids.length === 0 ? (
                          "—"
                        ) : (
                          <span className="flex flex-wrap gap-x-2">{ids.map(productLink)}</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>

          <Card title={t("nutrition.labels")}>
            {r.blockers.length > 0 ? (
              <div className="mb-4 space-y-1 text-sm">
                <p className="font-medium">{t("nutrition.labelBlocked")}</p>
                <ul className="list-disc ps-5" data-testid="label-blockers">
                  {r.blockers.map((b, i) => (
                    <li key={i}>{blockerText(b)}</li>
                  ))}
                </ul>
              </div>
            ) : hasPermission(ctx.grants, "nutrition.manage") ? (
              <div className="mb-4">
                <ConfirmActionButton
                  action={generateLabelAction.bind(null, orgSlug, recipeId)}
                  label={t("nutrition.generateLabel")}
                  variant="primary"
                />
              </div>
            ) : null}
            {labels.length === 0 ? (
              <EmptyState title={t("nutrition.noLabels")} />
            ) : (
              <ul className="space-y-1 text-sm">
                {labels.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/o/${orgSlug}/recipes/labels/${l.id}`}
                      className="text-primary hover:underline"
                    >
                      {t("nutrition.labelNo", { no: l.labelNo })}
                    </Link>
                    <LabelStatusBadge status={l.status} />
                    <span className="text-muted text-xs">
                      {format.dateTime(l.createdAt, {
                        dateStyle: "medium",
                        timeZone: ctx.timeZone,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
