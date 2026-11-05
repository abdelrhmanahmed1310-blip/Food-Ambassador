import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { QuestionForm } from "@/components/engagement/forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { canViewEngagement, surveyResults } from "@/modules/engagement/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  addQuestionAction,
  closeSurveyAction,
  openSurveyAction,
  removeQuestionAction,
} from "../actions";

/** A survey: questions while a draft, then anonymous results from five answers (ADR-127). */
export default async function SurveyPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/engagement/[surveyId]">) {
  const { orgSlug, surveyId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewEngagement(ctx) || !isUuid(surveyId)) notFound();
  const [t, r] = await Promise.all([getTranslations("engagement"), surveyResults(ctx, surveyId)]);
  const s = r.survey;
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
  return (
    <>
      <PageHeader
        title={s.title}
        description={s.intro ?? undefined}
        actions={<Badge tone="neutral">{t(`statuses.${s.status}`)}</Badge>}
      />
      <div className="space-y-6">
        {s.status === "DRAFT" ? (
          <>
            <Card title={t("questions")}>
              {s.questions.length === 0 ? (
                <p className="text-muted text-sm">{t("noQuestions")}</p>
              ) : (
                <ol className="space-y-2 text-sm">
                  {s.questions.map((q) => (
                    <li key={q.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {q.position}. {q.text}{" "}
                        <span className="text-muted">
                          ({t(`types.${q.type}`)}
                          {q.required ? `, ${t("required")}` : ""})
                        </span>
                      </span>
                      {r.canManage ? (
                        <ConfirmActionButton
                          action={removeQuestionAction.bind(null, orgSlug, q.id)}
                          label={t("remove")}
                          variant="secondary"
                        />
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </Card>
            {r.canManage ? (
              <>
                <Card title={t("addQuestion")}>
                  <QuestionForm action={addQuestionAction.bind(null, orgSlug, s.id)} />
                </Card>
                <ConfirmActionButton
                  action={openSurveyAction.bind(null, orgSlug, s.id)}
                  label={t("open")}
                  confirmMessage={t("openConfirm")}
                  variant="primary"
                />
              </>
            ) : null}
          </>
        ) : (
          <>
            <Card>
              <p className="text-sm" data-testid="survey-responses">
                {t("responseCount", { count: r.responses })}
                {r.responseRate !== null
                  ? ` · ${t("responseRate", { rate: pct(r.responseRate) })}`
                  : ""}
              </p>
            </Card>
            {!r.shown ? (
              <Alert tone="info">{t("tooFew", { min: r.minimum })}</Alert>
            ) : (
              r.questions.map((q, i) => (
                <Card key={q.id} title={`${i + 1}. ${q.text}`}>
                  <div className="space-y-2 text-sm" data-testid={`result-${i + 1}`}>
                    <p className="text-muted">{t("answerCount", { count: q.answers })}</p>
                    {"enps" in q && q.enps ? (
                      <p>
                        <span className="text-2xl font-bold tabular-nums">{q.enps.score}</span>{" "}
                        {t("enpsLine", {
                          promoters: q.enps.promoters,
                          passives: q.enps.passives,
                          detractors: q.enps.detractors,
                        })}
                      </p>
                    ) : null}
                    {"rating" in q && q.rating ? (
                      <p>
                        <span className="text-2xl font-bold tabular-nums">{q.rating.average}</span>{" "}
                        / 5 · {q.rating.counts.map((c, k) => `${k + 1}: ${c}`).join(" · ")}
                      </p>
                    ) : null}
                    {"yesShare" in q && q.yesShare !== null && q.yesShare !== undefined ? (
                      <p>{t("yesShare", { share: pct(q.yesShare) })}</p>
                    ) : null}
                    {"texts" in q && q.texts ? (
                      <ul className="list-disc space-y-1 ps-5">
                        {q.texts.map((x, k) => (
                          <li key={k} className="whitespace-pre-wrap">
                            {x}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {"byBranch" in q && q.byBranch && q.byBranch.length > 0 ? (
                      <ul className="text-muted text-xs">
                        {q.byBranch.map((b) => (
                          <li key={b.branch}>
                            {b.branch}: {b.enps ?? b.rating}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </Card>
              ))
            )}
            {r.canManage && s.status === "OPEN" ? (
              <ConfirmActionButton
                action={closeSurveyAction.bind(null, orgSlug, s.id)}
                label={t("close")}
                variant="secondary"
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
