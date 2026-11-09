import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, Table, Td, Th } from "@/components/ui/primitives";
import { Decimal } from "@/lib/decimal";
import type { recipeFullNutrition } from "@/modules/nutrition/engine/recipes";
import { productName, quantityFormatter } from "@/server/inventory-view";

type Panel = NonNullable<Awaited<ReturnType<typeof recipeFullNutrition>>["panel"]>;

/**
 * The recipe's full nutrient panel from linked library foods, with the
 * product's verified profile taking precedence (ADR-132). Totals are shown
 * only when every ingredient reports the nutrient.
 */
export async function FullNutrientPanel({ panel, orgSlug }: { panel: Panel; orgSlug: string }) {
  const [t, locale, fmt] = await Promise.all([
    getTranslations("nutritionEngine"),
    getLocale(),
    quantityFormatter(),
  ]);
  const name = (r: { name: string; nameAr: string | null }) =>
    (locale === "ar" && r.nameAr) || r.name;
  const show = (r: {
    amount: string | null;
    knownAmount: string;
    unit: string;
    complete: boolean;
  }) =>
    r.amount !== null ? (
      <span className="ltr-value tabular-nums">
        {fmt(new Decimal(r.amount).toDecimalPlaces(2))} {r.unit}
      </span>
    ) : (
      <span className="text-warning text-xs">
        {t("incompleteTotal")}
        {r.knownAmount !== "0" ? (
          <span className="ltr-value">
            {" "}
            (≥ {fmt(new Decimal(r.knownAmount).toDecimalPlaces(2))} {r.unit})
          </span>
        ) : null}
      </span>
    );
  const covered = panel.ingredients.filter(
    (i) =>
      i.coverage === "LIBRARY" || i.coverage === "PROFILE_AND_LIBRARY" || i.coverage === "PROFILE",
  ).length;
  return (
    <Card title={t("fullPanel")}>
      <p className="text-muted mb-3 text-sm">{t("fullPanelIntro")}</p>
      {panel.incomplete ? <Alert tone="error">{t("recipeIncomplete")}</Alert> : null}
      <p className="mb-3 text-sm">{t("coverage", { covered, total: panel.ingredients.length })}</p>
      <Table label={t("fullPanel")}>
        <thead>
          <tr>
            <Th>{t("nutrient")}</Th>
            <Th>{t("total")}</Th>
            {panel.perPortion ? <Th>{t("perPortion")}</Th> : null}
            {panel.per100g ? <Th>{t("per100gFinished")}</Th> : null}
          </tr>
        </thead>
        <tbody>
          {panel.total.map((r, i) => (
            <tr key={r.code} data-testid={`panel-${r.code}`}>
              <Td>
                {name(r)}
                {r.isCore ? <span className="text-muted ms-1 text-xs">●</span> : null}
              </Td>
              <Td>{show(r)}</Td>
              {panel.perPortion ? <Td>{show(panel.perPortion[i])}</Td> : null}
              {panel.per100g ? <Td>{show(panel.per100g[i])}</Td> : null}
            </tr>
          ))}
        </tbody>
      </Table>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-medium">{t("ingredientSources")}</summary>
        <ul className="mt-2 space-y-1">
          {panel.ingredients.map((i) => {
            const p = panel.names.get(i.productId);
            return (
              <li key={i.productId} className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/o/${orgSlug}/catalog/products/${i.productId}/nutrition`}
                  className="text-primary hover:underline"
                >
                  <bdi>{p ? `${p.sku} — ${productName(p, locale)}` : i.productId}</bdi>
                </Link>
                {i.grams ? (
                  <span className="ltr-value text-muted text-xs">{fmt(i.grams)} g</span>
                ) : null}
                <Badge
                  tone={
                    i.coverage === "NO_DATA" ||
                    i.coverage === "NO_WEIGHT" ||
                    i.coverage === "NEEDS_DENSITY"
                      ? "warning"
                      : "success"
                  }
                >
                  {t(`coverageKinds.${i.coverage}`)}
                </Badge>
                {i.food ? (
                  <Link
                    href={`/o/${orgSlug}/nutrition/foods/${i.food.id}`}
                    className="text-xs underline"
                  >
                    <bdi>{name(i.food)}</bdi>
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      </details>
    </Card>
  );
}
