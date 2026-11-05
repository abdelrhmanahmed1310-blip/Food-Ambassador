import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { GoalsSection } from "@/components/performance/goals-section";
import { Badge, Card, PageHeader } from "@/components/ui/primitives";
import { myPerformance } from "@/modules/performance/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { REVIEW_TONE } from "../../hr/performance/status";

/** The signed-in person's goals, reviews and the reviews they give (ADR-126). */
export default async function MyPerformancePage({
  params,
}: PageProps<"/o/[orgSlug]/my/performance">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const data = await myPerformance(ctx).catch(() => null);
  if (!data) notFound();
  const t = await getTranslations("performance");
  return (
    <>
      <PageHeader title={t("myPerformance")} />
      <div className="space-y-6">
        <Card title={t("myGoals")}>
          <GoalsSection
            orgSlug={orgSlug}
            employeeId={data.employeeId}
            goals={data.goals}
            reviews={data.reviews}
            cycles={[]}
            canSetGoals={false}
            canUpdate
          />
        </Card>
        {data.toGive.length > 0 ? (
          <Card title={t("toGive")}>
            <ul className="space-y-1 text-sm" data-testid="reviews-to-give">
              {data.toGive.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <Link
                    href={`/o/${orgSlug}/hr/performance/reviews/${r.id}`}
                    className="text-primary hover:underline"
                  >
                    {r.employee.firstName} {r.employee.lastName}
                  </Link>
                  <span className="text-muted">{r.cycle.name}</span>
                  <Badge tone={REVIEW_TONE[r.status]}>{t(`reviewStatuses.${r.status}`)}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
