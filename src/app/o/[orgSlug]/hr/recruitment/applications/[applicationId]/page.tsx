import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { HireForm, InterviewForm, MoveForm } from "@/components/recruitment/forms";
import { Badge, Card, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getApplication } from "@/modules/recruitment/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  cancelInterviewAction,
  hireAction,
  moveApplicationAction,
  scheduleInterviewAction,
} from "../../actions";
import { STAGE_TONE } from "../../status";

/** One candidate on one opening: stages, interviews and the hire (ADR-129). */
export default async function ApplicationPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/recruitment/applications/[applicationId]">) {
  const { orgSlug, applicationId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!isUuid(applicationId)) notFound();
  const [t, format, r] = await Promise.all([
    getTranslations("recruitment"),
    getFormatter(),
    getApplication(ctx, applicationId),
  ]);
  const a = r.application;
  const tz = r.branch.timeZone ?? ctx.timeZone;
  const when = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: tz });
  const base = `/o/${orgSlug}/hr/recruitment`;
  return (
    <>
      <PageHeader
        title={`${a.candidate.firstName} ${a.candidate.lastName}`}
        description={`${a.opening.number} · ${a.opening.jobTitle} · ${r.branch.code}`}
        actions={<Badge tone={STAGE_TONE[a.stage]}>{t(`stages.${a.stage}`)}</Badge>}
      />
      <div className="space-y-6">
        <div className="flex flex-wrap gap-4 text-sm">
          <Link href={`${base}/openings/${a.openingId}`} className="underline">
            {t("backToOpening")}
          </Link>
          <Link href={`${base}/candidates/${a.candidateId}`} className="underline">
            {t("candidateRecord")}
          </Link>
          {a.employeeId ? (
            <Link href={`/o/${orgSlug}/hr/employees/${a.employeeId}`} className="underline">
              {t("employeeRecord")}
            </Link>
          ) : null}
        </div>
        {r.can.moves.length ? (
          <Card title={t("move")}>
            <MoveForm
              action={moveApplicationAction.bind(null, orgSlug, a.id)}
              moves={[...r.can.moves]}
            />
          </Card>
        ) : null}
        <Card title={t("interviews")}>
          {r.interviews.length === 0 ? (
            <p className="text-muted text-sm">{t("noInterviews")}</p>
          ) : (
            <ul className="space-y-3 text-sm" data-testid="interviews">
              {r.interviews.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{t(`kinds.${i.kind}`)}</span> ·{" "}
                    {when(i.scheduledAt)} · {i.interviewer.name}
                    {i.location ? ` · ${i.location}` : ""}{" "}
                    <Badge
                      tone={
                        i.status === "DONE"
                          ? "success"
                          : i.status === "CANCELLED"
                            ? "muted"
                            : "neutral"
                      }
                    >
                      {t(`interviewStatuses.${i.status}`)}
                    </Badge>
                    {i.status === "DONE" ? (
                      <span className="text-muted block">
                        {t(`ratings.${i.rating}`)} · {t(`recommendations.${i.recommendation}`)}
                        {i.notes ? ` · ${i.notes}` : ""}
                      </span>
                    ) : null}
                  </span>
                  {r.can.manage && i.status === "SCHEDULED" ? (
                    <ConfirmActionButton
                      action={cancelInterviewAction.bind(null, orgSlug, i.id)}
                      label={t("cancelInterview")}
                      variant="secondary"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {r.scorecards.count ? (
            <p className="mt-3 text-sm" data-testid="scorecard-summary">
              {t("scoreLine", { average: r.scorecards.average ?? 0, count: r.scorecards.count })} ·{" "}
              {t("recommendLine", {
                hire: r.scorecards.hire,
                unsure: r.scorecards.unsure,
                noHire: r.scorecards.noHire,
              })}
            </p>
          ) : null}
        </Card>
        {r.can.schedule ? (
          <Card title={t("schedule")}>
            <InterviewForm
              action={scheduleInterviewAction.bind(null, orgSlug, a.id)}
              members={r.members.map((m) => ({ value: m.id, label: m.name }))}
            />
          </Card>
        ) : null}
        {r.can.hire ? (
          <Card title={t("hire")}>
            <p className="text-muted mb-3 text-sm">{t("hireHint")}</p>
            <HireForm
              action={hireAction.bind(null, orgSlug, a.id)}
              managers={r.managers.map((m) => ({
                value: m.id,
                label: `${m.firstName} ${m.lastName} (${m.jobTitle})`,
              }))}
              templates={r.templates.map((x) => ({ value: x.id, label: x.name }))}
            />
          </Card>
        ) : null}
        <Card title={t("history")}>
          <ol className="space-y-1 text-sm">
            {r.events.map((e) => (
              <li key={e.id}>
                {when(e.at)} · {t(`stages.${e.toStage}`)}
                {e.note ? ` · ${e.note}` : ""}
              </li>
            ))}
          </ol>
          {a.closeNote ? <p className="text-muted mt-2 text-sm">{a.closeNote}</p> : null}
        </Card>
      </div>
    </>
  );
}
