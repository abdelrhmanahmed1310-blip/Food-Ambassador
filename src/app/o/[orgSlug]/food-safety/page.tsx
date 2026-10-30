import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { NcStatusBadge } from "@/components/foodsafety/badges";
import { Card, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listNonConformances } from "@/modules/foodsafety/nonconformances";
import { listRecords } from "@/modules/foodsafety/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** Overview: what needs attention now, from real records only. */
export default async function FoodSafetyPage({ params }: PageProps<"/o/[orgSlug]/food-safety">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) notFound();
  const [t, format, open, outOfSpec] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listNonConformances(ctx, { open: true }),
    listRecords(ctx, { outOfSpec: true, take: 10 }),
  ]);
  const base = `/o/${orgSlug}/food-safety`;
  const overdue = open.reduce((a, r) => a + r.overdue, 0);
  return (
    <>
      <PageHeader title={t("foodSafety.title")} description={t("foodSafety.hint")} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t("foodSafety.openNcs")}>
          <p className="mb-3 text-sm">
            <span className="text-2xl font-semibold tabular-nums" data-testid="open-ncs">
              {open.length}
            </span>{" "}
            {overdue > 0 ? (
              <span className="text-danger">
                · {t("foodSafety.overdueCount", { count: overdue })}
              </span>
            ) : null}
          </p>
          <ul className="space-y-1 text-sm">
            {open.slice(0, 8).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Link
                  href={`${base}/non-conformances/${r.id}`}
                  className="ltr-value text-primary font-mono text-xs hover:underline"
                >
                  {r.number}
                </Link>
                {r.title} <NcStatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t("foodSafety.recentOutOfSpec")}>
          {outOfSpec.length === 0 ? (
            <p className="text-muted text-sm">{t("foodSafety.noOutOfSpec")}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {outOfSpec.map((r) => (
                <li key={r.id}>
                  <span className="ltr-value font-mono text-xs">{r.branch.code}</span> ·{" "}
                  {t(`foodSafety.recordTypes.${r.type}`)}
                  {r.checkpoint ? ` · ${r.checkpoint.name}` : ""}
                  {r.valueCelsius !== null ? (
                    <span className="ltr-value"> · {r.valueCelsius.toFixed()} °C</span>
                  ) : null}{" "}
                  ·{" "}
                  {format.dateTime(r.recordedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: ctx.timeZone,
                  })}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
