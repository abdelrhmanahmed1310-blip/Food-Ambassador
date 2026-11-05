import { getFormatter, getTranslations } from "next-intl/server";
import { ScorecardForm } from "@/components/recruitment/forms";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { myInterviews } from "@/modules/recruitment/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { submitScorecardAction } from "../../hr/recruitment/actions";

/** Interviews the signed-in user runs, and their scorecards (ADR-129). */
export default async function MyInterviewsPage({
  params,
}: PageProps<"/o/[orgSlug]/my/interviews">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, format, list] = await Promise.all([
    getTranslations("recruitment"),
    getFormatter(),
    myInterviews(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("myInterviews")} description={t("myInterviewsHint")} />
      {list.length === 0 ? (
        <EmptyState title={t("noMyInterviews")} />
      ) : (
        <div className="space-y-4">
          {list.map((i) => (
            <Card
              key={i.id}
              title={`${i.application.candidate.firstName} ${i.application.candidate.lastName} · ${i.application.opening.jobTitle}`}
              actions={
                <Badge tone={i.status === "DONE" ? "success" : "neutral"}>
                  {t(`interviewStatuses.${i.status}`)}
                </Badge>
              }
            >
              <p className="text-sm">
                {t(`kinds.${i.kind}`)} ·{" "}
                {format.dateTime(i.scheduledAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: i.application.opening.branch.timeZone ?? ctx.timeZone,
                })}{" "}
                · {i.application.opening.number} · {i.application.opening.branch.code}
                {i.location ? ` · ${i.location}` : ""}
              </p>
              {i.mayScore ? (
                <div className="mt-4">
                  <ScorecardForm action={submitScorecardAction.bind(null, orgSlug, i.id)} />
                </div>
              ) : i.status === "DONE" ? (
                <p className="text-muted mt-2 text-sm">
                  {t(`ratings.${i.rating}`)} · {t(`recommendations.${i.recommendation}`)}
                </p>
              ) : (
                <p className="text-muted mt-2 text-sm">{t("scoreAfter")}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
