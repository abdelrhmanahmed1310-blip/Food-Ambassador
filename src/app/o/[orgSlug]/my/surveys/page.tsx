import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Alert, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { surveysToAnswer } from "@/modules/engagement/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** Surveys waiting for the signed-in employee (ADR-127). */
export default async function MySurveysPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/my/surveys">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const [t, surveys] = await Promise.all([getTranslations("engagement"), surveysToAnswer(ctx)]);
  return (
    <>
      <PageHeader title={t("mySurveys")} description={t("anonymousNote")} />
      <div className="space-y-4">
        {sp.thanks ? <Alert tone="success">{t("thanks")}</Alert> : null}
        {surveys.length === 0 ? (
          <EmptyState title={t("nothingToAnswer")} />
        ) : (
          surveys.map((s) => (
            <Card key={s.id} title={s.title}>
              {s.intro ? <p className="text-muted mb-2 text-sm">{s.intro}</p> : null}
              <Link
                href={`/o/${orgSlug}/my/surveys/${s.id}`}
                className="text-primary text-sm hover:underline"
              >
                {t("answerNow")}
              </Link>
            </Card>
          ))
        )}
      </div>
    </>
  );
}
