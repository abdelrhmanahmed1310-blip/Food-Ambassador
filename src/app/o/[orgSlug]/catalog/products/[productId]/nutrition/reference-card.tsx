import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ReferencePicker, type PickerItem } from "@/components/nutrition/reference-picker";
import { Badge, Card, Table, Td } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import type { searchFoods } from "@/modules/nutrition/engine/foods";
import type { productReference } from "@/modules/nutrition/product-reference";
import { quantityFormatter } from "@/server/inventory-view";
import {
  unlinkReferenceAction,
  chooseReferenceAction,
} from "../../../../recipes/nutrition-actions";

const SOURCE_LABEL: Record<string, string> = {
  USDA_FDC: "USDA FDC",
  OPEN_FOOD_FACTS: "Open Food Facts",
  WIKIDATA: "Wikidata",
  MANUAL: "Library",
};

/**
 * The product's generic library food (ADR-136): its full nutrient profile
 * feeds recipe panels. Shows the link with core values, or suggestions, and
 * a search of the library and USDA to choose one.
 */
export async function ReferenceCard({
  orgSlug,
  productId,
  manage,
  reference,
  query,
  found,
}: {
  orgSlug: string;
  productId: string;
  manage: boolean;
  reference: Awaited<ReturnType<typeof productReference>>;
  query: string;
  found: Awaited<ReturnType<typeof searchFoods>> | null;
}) {
  const [t, locale, fmt] = await Promise.all([getTranslations(), getLocale(), quantityFormatter()]);
  const name = (x: { name: string; nameAr: string | null }) =>
    (locale === "ar" && x.nameAr) || x.name;
  const food = reference.food;
  const groups: Array<{ title: string; empty?: string; items: PickerItem[] }> = [];
  if (!food && reference.suggestions.length > 0)
    groups.push({
      title: t("productReference.suggestions"),
      items: reference.suggestions.map((c) => ({
        pick: `food:${c.id}`,
        name: name(c),
        meta: [
          `${SOURCE_LABEL[c.source]} ${c.sourceId}`,
          c.match === "BARCODE"
            ? t("productReference.barcodeMatch")
            : t("productReference.nameMatch", { score: Math.round(c.score * 100) }),
          t("productReference.nutrientCount", { count: c.nutrients }),
        ].join(" · "),
      })),
    });
  if (found) {
    groups.push({
      title: t("productReference.inLibrary"),
      empty: t("productReference.noneFound"),
      items: found.local.items
        .filter((h) => h.id !== food?.id)
        .map((h) => ({
          pick: `food:${h.id}`,
          name: name(h),
          meta: [
            `${SOURCE_LABEL[h.source]} ${h.sourceId}`,
            h.dataType,
            h.energyKcal ? `${fmt(h.energyKcal)} kcal` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        })),
    });
    groups.push({
      title: t("productReference.fromUsda"),
      empty:
        found.external.status === "OK"
          ? t("productReference.noneFound")
          : t(`productReference.usda.${found.external.status}`),
      items: found.external.items.map((h) => ({
        pick: `fdc:${h.fdcId}`,
        name: h.name,
        meta: [`USDA FDC ${h.fdcId}`, h.dataType, h.energyKcal ? `${fmt(h.energyKcal)} kcal` : null]
          .filter(Boolean)
          .join(" · "),
      })),
    });
  }
  return (
    <Card title={t("productReference.title")}>
      <div className="space-y-4" data-testid="product-reference">
        <p className="text-muted text-sm">{t("productReference.intro")}</p>
        {food ? (
          <div className="space-y-3">
            <p className="text-sm">
              <Link
                href={`/o/${orgSlug}/nutrition/foods/${food.id}`}
                className="text-primary font-medium hover:underline"
                data-testid="reference-food"
              >
                <bdi>{name(food)}</bdi>
              </Link>{" "}
              · {SOURCE_LABEL[food.source]} <span className="ltr-value">{food.sourceId}</span>
              {food.dataType ? <> · {food.dataType}</> : null}{" "}
              {food.verified ? (
                <Badge tone="success">{t("productReference.verified")}</Badge>
              ) : (
                <Badge tone="warning">{t("productReference.notVerified")}</Badge>
              )}
              {food.archived ? <Badge tone="danger">{t("productReference.archived")}</Badge> : null}
            </p>
            <p className="text-sm" data-testid="reference-nutrient-count">
              {t("productReference.fullProfile", { count: food.nutrients })}
              {food.basis ? <> · {t(`nutrition.bases.${food.basis}`)}</> : null}
            </p>
            {reference.core.length > 0 ? (
              <Table label={t("productReference.coreValues")}>
                <tbody>
                  {reference.core.map((v) => (
                    <tr key={v.code ?? v.name}>
                      <Td>{name(v)}</Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value">
                          {v.amount === null
                            ? t("nutrition.unknown")
                            : `${fmt(v.amount)} ${v.unit}`}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
            {manage ? (
              <ConfirmActionButton
                action={unlinkReferenceAction.bind(null, orgSlug, productId)}
                label={t("productReference.unlink")}
                confirmMessage={t("productReference.confirmUnlink")}
              />
            ) : null}
          </div>
        ) : (
          <p className="text-sm font-medium">{t("productReference.none")}</p>
        )}
        {manage ? (
          <>
            <form method="get" className="flex flex-wrap items-end gap-2">
              <label className="text-sm">
                <span className="mb-1 block font-medium">
                  {food ? t("productReference.change") : t("productReference.search")}
                </span>
                <input
                  name="ref"
                  defaultValue={query}
                  placeholder={t("productReference.searchPlaceholder")}
                  className={`${inputClass} w-72`}
                />
              </label>
              <button type="submit" className={buttonClass("secondary")}>
                {t("common.search")}
              </button>
            </form>
            {/* Always mounted, so the outcome stays on screen after the list changes. */}
            <ReferencePicker
              action={chooseReferenceAction.bind(null, orgSlug, productId)}
              groups={groups}
              useLabel={t("productReference.use")}
            />
          </>
        ) : null}
      </div>
    </Card>
  );
}
