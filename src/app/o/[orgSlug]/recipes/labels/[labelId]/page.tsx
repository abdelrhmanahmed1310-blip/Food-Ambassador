import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { LabelStatusBadge } from "@/components/nutrition/badges";
import { LabelReviewForm } from "@/components/nutrition/forms";
import { Alert, Card } from "@/components/ui/primitives";
import { PrintButton } from "@/components/ui/print-button";
import { isUuid } from "@/lib/uuid";
import { NUTRIENTS } from "@/modules/nutrition/rules";
import { getLabel } from "@/modules/nutrition/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { reviewLabelAction } from "../../nutrition-actions";

const UNITS: Record<string, string> = { energyKcal: "kcal", energyKj: "kJ" };

/** A calculated label; printable only once approved. */
export default async function LabelPage({
  params,
}: PageProps<"/o/[orgSlug]/recipes/labels/[labelId]">) {
  const { orgSlug, labelId } = await params;
  if (!isUuid(labelId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const label = await notFoundOnAppError(getLabel(ctx, labelId));
  const [t, locale, format] = await Promise.all([getTranslations(), getLocale(), getFormatter()]);
  const c = label.content;
  const approved = label.status === "APPROVED";
  const dt = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const allergenList = (codes: string[]) =>
    codes.map((code) => t(`nutrition.allergenNames.${code as "MILK"}`)).join(", ");
  return (
    <article className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href={`/o/${orgSlug}/recipes/${label.recipe.id}/nutrition`}
          className="text-primary text-sm hover:underline"
        >
          {t("common.back")}
        </Link>
        <div className="flex items-center gap-3">
          <LabelStatusBadge status={label.status} />
          {approved && !label.stale ? <PrintButton label={t("recipes.print")} /> : null}
        </div>
      </div>
      <div className="space-y-3 print:hidden">
        {label.stale ? <Alert tone="error">{t("nutrition.labelStale")}</Alert> : null}
        {!approved ? <Alert tone="info">{t("nutrition.labelNotApproved")}</Alert> : null}
        <p className="text-muted text-xs">
          {t("nutrition.labelNo", { no: label.labelNo })} ·{" "}
          {t("nutrition.generatedBy", {
            name: label.names.createdBy ?? "—",
            at: dt(label.createdAt),
          })}
          {label.reviewedAt ? (
            <>
              {" "}
              ·{" "}
              {t("nutrition.reviewedBy", {
                name: label.names.reviewedBy ?? "—",
                at: dt(label.reviewedAt),
              })}
            </>
          ) : null}
          {label.reviewNote ? (
            <>
              {" "}
              · <bdi>{label.reviewNote}</bdi>
            </>
          ) : null}
        </p>
      </div>

      <section
        className={`border-foreground space-y-4 border-2 p-5 ${approved ? "" : "opacity-80"}`}
        data-testid="label"
      >
        {!approved ? (
          <p className="text-danger text-center text-sm font-semibold uppercase">
            {t("nutrition.draftWatermark")}
          </p>
        ) : null}
        <header>
          <h1 className="text-xl font-semibold">
            {(locale === "ar" && c.recipe.nameAr) || c.recipe.name}
          </h1>
          <p className="ltr-value text-muted font-mono text-xs">
            {c.recipe.code} · v{c.recipe.versionNo}
          </p>
        </header>
        <div>
          <h2 className="text-sm font-semibold">{t("nutrition.ingredientsLabel")}</h2>
          <p className="text-sm" data-testid="label-ingredients">
            {c.ingredients.map((i) => (locale === "ar" && i.nameAr) || i.name).join(", ")}
          </p>
        </div>
        <div data-testid="label-allergens">
          {c.contains.length > 0 ? (
            <p className="text-sm">
              <strong>{t("nutrition.contains")}:</strong> {allergenList(c.contains)}
            </p>
          ) : null}
          {c.mayContain.length > 0 ? (
            <p className="text-sm">
              <strong>{t("nutrition.mayContain")}:</strong> {allergenList(c.mayContain)}
            </p>
          ) : null}
          {c.contains.length + c.mayContain.length === 0 ? (
            <p className="text-sm">{t("nutrition.noDeclaredAllergens")}</p>
          ) : null}
        </div>
        <table className="w-full text-sm" data-testid="label-nutrition">
          <thead>
            <tr className="border-foreground border-b">
              <th className="py-1 text-start">{t("nutrition.nutrient")}</th>
              {c.per100 ? (
                <th className="py-1 text-end">{t(`nutrition.bases.${c.per100Basis}`)}</th>
              ) : null}
              {c.perPortion ? <th className="py-1 text-end">{t("nutrition.perPortion")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {NUTRIENTS.filter((n) => (c.perPortion ?? c.per100)?.[n] !== null).map((n) => (
              <tr key={n} className="border-border border-b">
                <td className="py-1">{t(`nutrition.nutrients.${n}`)}</td>
                {c.per100 ? (
                  <td className="ltr-value py-1 text-end tabular-nums">
                    {c.per100[n]} {UNITS[n] ?? "g"}
                  </td>
                ) : null}
                {c.perPortion ? (
                  <td
                    className="ltr-value py-1 text-end tabular-nums"
                    data-testid={`label-portion-${n}`}
                  >
                    {c.perPortion[n]} {UNITS[n] ?? "g"}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-muted text-xs">{t("nutrition.labelDisclaimer")}</p>
      </section>

      {label.can.review ? (
        <Card title={t("nutrition.review")}>
          <p className="text-muted mb-3 text-sm">
            {label.stale ? t("nutrition.staleReviewHint") : t("nutrition.reviewHint")}
          </p>
          <LabelReviewForm action={reviewLabelAction.bind(null, orgSlug, label.id)} />
        </Card>
      ) : null}
    </article>
  );
}
