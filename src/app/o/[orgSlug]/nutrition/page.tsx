import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { StatTile } from "@/components/nutrition/engine-view";
import { Alert, Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { nutritionDashboard } from "@/modules/nutrition/engine/quality";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { Tabs } from "./tabs";

/** Nutrition engine dashboard (ADR-132): what the library holds, its sources, sync and quality. */
export default async function NutritionDashboardPage({
  params,
}: PageProps<"/o/[orgSlug]/nutrition">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "nutrition.view")) notFound();
  const [t, format, d] = await Promise.all([
    getTranslations("nutritionEngine"),
    getFormatter(),
    nutritionDashboard(ctx),
  ]);
  const base = `/o/${orgSlug}/nutrition`;
  const when = (v: Date | null) =>
    v
      ? format.dateTime(v, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <Tabs orgSlug={orgSlug} current="" />
      <div className="space-y-6">
        {d.usdaConfigured ? null : <Alert tone="info">{t("usdaNotConfigured")}</Alert>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="nutrition-stats">
          <StatTile label={t("stats.foods")} value={d.foods} href={`${base}/foods?mode=LOCAL`} />
          <StatTile
            label={t("stats.usda")}
            value={d.usda}
            href={`${base}/foods?mode=LOCAL&source=USDA_FDC`}
          />
          <StatTile
            label={t("stats.manual")}
            value={d.manual}
            href={`${base}/foods?mode=LOCAL&source=MANUAL`}
          />
          <StatTile label={t("stats.nutrients")} value={d.nutrients} href={`${base}/nutrients`} />
          <StatTile label={t("stats.foundation")} value={d.foundation} />
          <StatTile label={t("stats.srLegacy")} value={d.srLegacy} />
          <StatTile label={t("stats.fndds")} value={d.fndds} />
          <StatTile label={t("stats.branded")} value={d.branded} />
          <StatTile
            label={t("stats.awaitingVerification")}
            value={d.awaitingVerification}
            href={`${base}/foods?mode=LOCAL&verified=false`}
          />
          <StatTile label={t("stats.openIssues")} value={d.openIssues} href={`${base}/quality`} />
          <StatTile label={t("stats.failedJobs")} value={d.failedJobs} href={`${base}/usda`} />
          <StatTile label={t("stats.archived")} value={d.archived} />
        </div>
        <Card title={t("sync")}>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">{t("usdaStatus")}</dt>
              <dd>{d.usdaConfigured ? t("configured") : t("notConfigured")}</dd>
            </div>
            <div>
              <dt className="text-muted">{t("lastSync")}</dt>
              <dd className="ltr-value">{when(d.lastSyncAt)}</dd>
            </div>
            <div>
              <dt className="text-muted">{t("lastJob")}</dt>
              <dd>
                {d.lastJob
                  ? `${t(`syncKinds.${d.lastJob.kind}`)} · ${t(`syncStatuses.${d.lastJob.status}`)} · `
                  : "—"}
                {d.lastJob ? <span className="ltr-value">{when(d.lastJob.createdAt)}</span> : null}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm">
            <Link href={`${base}/usda`} className="text-primary hover:underline">
              {t("tabs.usda")}
            </Link>{" "}
            ·{" "}
            <Link href={`/o/${orgSlug}/catalog/library`} className="text-primary hover:underline">
              {t("fileImports")}
            </Link>
          </p>
        </Card>
      </div>
    </>
  );
}
