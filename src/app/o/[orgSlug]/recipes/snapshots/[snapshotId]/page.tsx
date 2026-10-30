import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { CostBreakdown } from "@/components/recipes/breakdown";
import { Alert, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { getSnapshot } from "@/modules/recipes/costs";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, quantityFormatter } from "@/server/inventory-view";

export default async function SnapshotPage({
  params,
}: PageProps<"/o/[orgSlug]/recipes/snapshots/[snapshotId]">) {
  const { orgSlug, snapshotId } = await params;
  if (!isUuid(snapshotId)) notFound();
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "recipes.costs.view")) notFound();
  const s = await notFoundOnAppError(getSnapshot(ctx, snapshotId));
  const [t, locale, format, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const recipe = s.version.recipe;
  return (
    <>
      <PageHeader
        title={t("recipes.snapshotTitle", { code: recipe.code, no: s.version.versionNo })}
        description={format.dateTime(s.calculatedAt, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: ctx.timeZone,
        })}
        actions={
          <Link
            href={`/o/${orgSlug}/recipes/${recipe.id}`}
            className="text-primary text-sm hover:underline"
          >
            {recipe.code}
          </Link>
        }
      />
      <div className="space-y-6">
        <Alert tone="info">{t("recipes.snapshotHint")}</Alert>
        <Card>
          <DescriptionList
            items={[
              {
                label: t("recipes.snapshotReason"),
                value: t(`recipes.snapshotReasons.${s.reason}`),
              },
              { label: t("recipes.policy"), value: t(`recipes.policies.${s.policy}`) },
              {
                label: t("recipes.averageFrom"),
                value: s.warehouse?.code ?? t("recipes.wholeOrganization"),
              },
              { label: t("recipes.asOf"), value: s.asOf.toISOString().slice(0, 10) },
              {
                label: t("recipes.totalCost"),
                value: <span className="ltr-value tabular-nums">{money.money(s.totalCost)}</span>,
              },
              {
                label: t("recipes.costPerPortion"),
                value: (
                  <span className="ltr-value tabular-nums">
                    {s.costPerPortion ? money.money(s.costPerPortion) : "—"}
                  </span>
                ),
              },
            ]}
          />
        </Card>
        {s.missingCount > 0 ? (
          <Alert tone="error">{t("recipes.incomplete", { count: s.missingCount })}</Alert>
        ) : null}
        <CostBreakdown
          cost={s.breakdown}
          names={s.names}
          locale={locale}
          money={money.money}
          unitCost={money.unitCost}
          fmt={fmt}
        />
      </div>
    </>
  );
}
