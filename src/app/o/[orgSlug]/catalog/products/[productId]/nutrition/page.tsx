import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { AllergenStatusBadge } from "@/components/nutrition/badges";
import { AllergenForm, NutritionProfileForm } from "@/components/nutrition/forms";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { getProductNutrition, SOURCES } from "@/modules/nutrition/service";
import { NUTRIENTS } from "@/modules/nutrition/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName, quantityFormatter } from "@/server/inventory-view";
import {
  declareAllergensAction,
  recordProfileAction,
  verifyAllergensAction,
  verifyProfileAction,
} from "../../../../recipes/nutrition-actions";

export default async function ProductNutritionPage({
  params,
}: PageProps<"/o/[orgSlug]/catalog/products/[productId]/nutrition">) {
  const { orgSlug, productId } = await params;
  if (!isUuid(productId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const n = await notFoundOnAppError(getProductNutrition(ctx, productId));
  const [t, locale, format, fmt] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
  ]);
  const manage = hasPermission(ctx.grants, "nutrition.manage");
  const sources = SOURCES.map((s) => ({ value: s, label: t(`nutrition.sources.${s}`) }));
  const dt = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const p = n.profile;
  return (
    <>
      <PageHeader
        title={t("nutrition.productTitle", { name: productName(n.product, locale) })}
        description={n.product.sku}
        actions={
          <Link
            href={`/o/${orgSlug}/catalog/products/${productId}`}
            className="text-primary text-sm hover:underline"
          >
            {t("common.back")}
          </Link>
        }
      />
      <div className="space-y-6">
        <Alert tone="info">{t("nutrition.neverInferred")}</Alert>
        <Card title={t("nutrition.values")}>
          {!p ? (
            <EmptyState title={t("nutrition.noValues")} />
          ) : (
            <div className="space-y-3">
              <p className="text-sm">
                {t(`nutrition.bases.${p.basis}`)} · {t(`nutrition.sources.${p.source}`)}
                {p.reference ? (
                  <>
                    {" "}
                    · <bdi>{p.reference}</bdi>
                  </>
                ) : null}{" "}
                ·{" "}
                {p.verifiedAt ? (
                  <Badge tone="success">
                    {t("nutrition.verifiedBy", { name: n.name(p.verifiedByUserId) ?? "—" })}
                  </Badge>
                ) : (
                  <Badge tone="warning">{t("nutrition.notVerified")}</Badge>
                )}
              </p>
              <p className="text-muted text-xs">
                {t("nutrition.enteredBy", {
                  name: n.name(p.createdByUserId) ?? "—",
                  at: dt(p.createdAt),
                })}
              </p>
              <Table label={t("nutrition.values")}>
                <tbody>
                  {NUTRIENTS.map((k) => (
                    <tr key={k} data-testid={`nutrient-${k}`}>
                      <Td>{t(`nutrition.nutrients.${k}`)}</Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value">
                          {p[k] === null ? t("nutrition.unknown") : fmt(p[k]!)}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {manage && n.can.verifyProfile ? (
                <ConfirmActionButton
                  action={verifyProfileAction.bind(null, orgSlug, productId)}
                  label={t("nutrition.verifyValues")}
                  confirmMessage={t("nutrition.confirmVerify")}
                  variant="primary"
                />
              ) : null}
            </div>
          )}
          {manage ? (
            <div className="border-border mt-6 border-t pt-4">
              <h3 className="mb-3 font-medium">
                {p ? t("nutrition.replaceValues") : t("nutrition.enterValues")}
              </h3>
              <NutritionProfileForm
                action={recordProfileAction.bind(null, orgSlug, productId)}
                sources={sources}
                defaultBasis={n.product.baseUom.dimension === "VOLUME" ? "PER_100ML" : "PER_100G"}
              />
            </div>
          ) : null}
        </Card>

        <Card title={t("nutrition.allergens")}>
          <Table label={t("nutrition.allergens")}>
            <thead>
              <tr>
                <Th>{t("nutrition.allergen")}</Th>
                <Th>{t("nutrition.statement")}</Th>
                <Th>{t("nutrition.source")}</Th>
                <Th>{t("nutrition.verification")}</Th>
              </tr>
            </thead>
            <tbody>
              {n.allergens.map((a) => (
                <tr key={a.code} data-testid={`allergen-${a.code}`}>
                  <Td>{t(`nutrition.allergenNames.${a.code}`)}</Td>
                  <Td>
                    <AllergenStatusBadge status={a.current?.status ?? "UNKNOWN"} />
                  </Td>
                  <Td>
                    {a.current ? (
                      <>
                        {t(`nutrition.sources.${a.current.source}`)}
                        {a.current.reference ? (
                          <span className="text-muted block text-xs">
                            <bdi>{a.current.reference}</bdi>
                          </span>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="text-xs">
                    {!a.current || a.current.status === "UNKNOWN"
                      ? "—"
                      : a.current.verifiedAt
                        ? t("nutrition.verifiedBy", {
                            name: n.name(a.current.verifiedByUserId) ?? "—",
                          })
                        : t("nutrition.declaredBy", {
                            name: n.name(a.current.declaredByUserId) ?? "—",
                          })}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {manage && n.can.verifyAllergens ? (
            <div className="mt-4">
              <ConfirmActionButton
                action={verifyAllergensAction.bind(null, orgSlug, productId)}
                label={t("nutrition.verifyAllergens")}
                confirmMessage={t("nutrition.confirmVerify")}
                variant="primary"
              />
            </div>
          ) : null}
          {manage ? (
            <div className="border-border mt-6 border-t pt-4">
              <AllergenForm
                action={declareAllergensAction.bind(null, orgSlug, productId)}
                sources={sources}
                allergens={n.allergens.map((a) => ({
                  code: a.code,
                  label: t(`nutrition.allergenNames.${a.code}`),
                  current: a.current?.status ?? null,
                }))}
              />
            </div>
          ) : null}
        </Card>

        {n.declarationHistory.length + n.profileHistory.length > 0 ? (
          <Card title={t("nutrition.history")}>
            <ul className="space-y-1 text-sm">
              {n.profileHistory.map((h) => (
                <li key={h.id}>
                  {dt(h.createdAt)} · {t("nutrition.values")} · {t(`nutrition.sources.${h.source}`)}
                  {h.reference ? (
                    <>
                      {" "}
                      · <bdi>{h.reference}</bdi>
                    </>
                  ) : null}
                </li>
              ))}
              {n.declarationHistory.map((h) => (
                <li key={h.id}>
                  {dt(h.declaredAt)} · {t(`nutrition.allergenNames.${h.allergen as "MILK"}`)} ·{" "}
                  {t(`nutrition.statements.${h.status}`)} ·{" "}
                  <bdi>{n.name(h.declaredByUserId) ?? "—"}</bdi>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
