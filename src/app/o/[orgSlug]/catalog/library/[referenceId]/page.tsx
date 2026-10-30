import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { LinkReferenceForm } from "@/components/nutrition/library-forms";
import { Alert, Card, DescriptionList, PageHeader, Table, Td } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { listProductOptions } from "@/modules/catalog/service";
import { getReferenceFood } from "@/modules/nutrition/library";
import { NUTRIENTS } from "@/modules/nutrition/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName, quantityFormatter } from "@/server/inventory-view";
import { linkReferenceAction } from "../actions";

export default async function ReferenceFoodPage({
  params,
}: PageProps<"/o/[orgSlug]/catalog/library/[referenceId]">) {
  const { orgSlug, referenceId } = await params;
  if (!isUuid(referenceId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const food = await notFoundOnAppError(getReferenceFood(ctx, referenceId));
  const canLink =
    hasPermission(ctx.grants, "nutrition.manage") && hasPermission(ctx.grants, "catalog.view");
  const [t, locale, fmt, products] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    canLink ? listProductOptions(ctx) : Promise.resolve([]),
  ]);
  const hasValues = NUTRIENTS.some((n) => food[n] !== null);
  const names = (codes: string[]) =>
    codes.map((c) => t(`nutrition.allergenNames.${c as "MILK"}`)).join(", ") || "—";
  return (
    <>
      <PageHeader
        title={(locale === "ar" && food.nameAr) || food.name}
        description={`${t(`library.sources.${food.source}`)} · ${food.sourceId}${food.dataType ? ` · ${food.dataType}` : ""}`}
        actions={
          <Link
            href={`/o/${orgSlug}/catalog/library`}
            className="text-primary text-sm hover:underline"
          >
            {t("common.back")}
          </Link>
        }
      />
      <div className="space-y-6">
        <Alert tone="info">{t("library.notVerifiedNote")}</Alert>
        <Card>
          <DescriptionList
            items={[
              { label: t("library.name"), value: <bdi>{food.name}</bdi> },
              { label: t("library.nameAr"), value: food.nameAr ? <bdi>{food.nameAr}</bdi> : "—" },
              ...(food.brand
                ? [{ label: t("library.brand"), value: <bdi>{food.brand}</bdi> }]
                : []),
              ...(food.description
                ? [{ label: t("library.description"), value: <bdi>{food.description}</bdi> }]
                : []),
              {
                label: t("library.record"),
                value: (
                  <a
                    href={food.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ltr-value text-primary break-all hover:underline"
                  >
                    {food.sourceUrl}
                  </a>
                ),
              },
              { label: t("library.licence"), value: food.licence },
              { label: t("library.attribution"), value: food.attribution },
              { label: t("library.importedFrom"), value: <bdi>{food.import.fileName}</bdi> },
              ...(food.linkedProduct
                ? [
                    {
                      label: t("library.linkedTo"),
                      value: (
                        <Link
                          href={`/o/${orgSlug}/catalog/products/${food.linkedProduct.id}/nutrition`}
                          className="text-primary hover:underline"
                        >
                          {food.linkedProduct.sku} — {productName(food.linkedProduct, locale)}
                        </Link>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>
        {food.basis || hasValues ? (
          <Card
            title={`${t("nutrition.values")} — ${food.basis ? t(`nutrition.bases.${food.basis}`) : ""}`}
          >
            <Table label={t("nutrition.values")}>
              <tbody>
                {NUTRIENTS.map((n) => (
                  <tr key={n} data-testid={`ref-nutrient-${n}`}>
                    <Td>{t(`nutrition.nutrients.${n}`)}</Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value">
                        {food[n] === null ? t("nutrition.unknown") : fmt(food[n]!)}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : null}
        {food.source === "OPEN_FOOD_FACTS" ? (
          <Card title={t("nutrition.allergens")}>
            <p className="text-sm">
              <strong>{t("nutrition.contains")}:</strong> {names(food.allergens)}
            </p>
            <p className="text-sm">
              <strong>{t("nutrition.mayContain")}:</strong> {names(food.traces)}
            </p>
            {food.unmappedTags.length > 0 ? (
              <p className="text-muted mt-2 text-xs">
                {t("library.unmappedTags")}{" "}
                <span className="ltr-value">{food.unmappedTags.join(", ")}</span>
              </p>
            ) : null}
            <p className="text-muted mt-2 text-xs">{t("library.absenceNote")}</p>
          </Card>
        ) : null}
        {food.notes.length > 0 ? (
          <Card title={t("library.notes")}>
            <ul className="ltr-value list-disc space-y-1 ps-5 text-sm">
              {food.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </Card>
        ) : null}
        {canLink ? (
          <Card title={t("library.linkTitle")}>
            <p className="text-muted mb-3 text-sm">{t("library.linkHint")}</p>
            <LinkReferenceForm
              action={linkReferenceAction.bind(null, orgSlug, food.id)}
              products={products.map((p) => ({
                value: p.id,
                label: `${p.sku} — ${productName(p, locale)}`,
              }))}
              hasValues={hasValues && !!food.basis}
              hasAllergens={food.allergens.length + food.traces.length > 0}
              hasArabicName={!!food.nameAr}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
