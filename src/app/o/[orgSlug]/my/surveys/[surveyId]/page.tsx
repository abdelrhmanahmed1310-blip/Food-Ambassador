import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AnswerForm } from "@/components/engagement/forms";
import { Alert, Card, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { surveyToAnswer } from "@/modules/engagement/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { submitSurveyAction } from "../../../hr/engagement/actions";

export default async function AnswerSurveyPage({
  params,
}: PageProps<"/o/[orgSlug]/my/surveys/[surveyId]">) {
  const { orgSlug, surveyId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!isUuid(surveyId)) notFound();
  const d = await surveyToAnswer(ctx, surveyId).catch(() => null);
  if (!d) notFound();
  const t = await getTranslations("engagement");
  return (
    <>
      <PageHeader title={d.survey.title} description={d.survey.intro ?? undefined} />
      {d.answered ? (
        <Alert tone="success">{t("alreadyAnswered")}</Alert>
      ) : !d.open ? (
        <Alert tone="info">{t("notOpen")}</Alert>
      ) : (
        <Card>
          <AnswerForm
            action={submitSurveyAction.bind(null, orgSlug, d.survey.id)}
            questions={d.questions}
          />
        </Card>
      )}
    </>
  );
}
