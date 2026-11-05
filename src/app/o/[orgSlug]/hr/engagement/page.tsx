import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SurveyForm } from "@/components/engagement/forms";
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { canViewEngagement, listSurveys } from "@/modules/engagement/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createSurveyAction } from "./actions";

const TONE = { DRAFT: "muted", OPEN: "warning", CLOSED: "success" } as const;

/** Staff surveys (ADR-127). */
export default async function EngagementPage({ params }: PageProps<"/o/[orgSlug]/hr/engagement">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewEngagement(ctx)) notFound();
  const [t, data] = await Promise.all([getTranslations("engagement"), listSurveys(ctx)]);
  const branch = new Map(data.branches.map((b) => [b.id, b.code]));
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("hint")}
        actions={
          <LinkButton href={`/o/${orgSlug}/recognition`} variant="secondary">
            {t("wall")}
          </LinkButton>
        }
      />
      <div className="space-y-6">
        {data.surveys.length === 0 ? (
          <EmptyState title={t("noSurveys")} />
        ) : (
          <Table label={t("title")}>
            <thead>
              <tr>
                <Th>{t("surveyTitle")}</Th>
                <Th>{t("audience")}</Th>
                <Th>{t("questions")}</Th>
                <Th>{t("responses")}</Th>
                <Th>{t("status")}</Th>
              </tr>
            </thead>
            <tbody>
              {data.surveys.map((s) => (
                <tr key={s.id}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/hr/engagement/${s.id}`}
                      className="text-primary hover:underline"
                    >
                      {s.title}
                    </Link>
                  </Td>
                  <Td>{s.branchId ? (branch.get(s.branchId) ?? "—") : t("everyone")}</Td>
                  <Td className="tabular-nums">{s._count.questions}</Td>
                  <Td className="tabular-nums">
                    {s._count.responses}
                    {s.audienceCount ? ` / ${s.audienceCount}` : ""}
                  </Td>
                  <Td>
                    <Badge tone={TONE[s.status]}>{t(`statuses.${s.status}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data.canManage ? (
          <Card title={t("createSurvey")}>
            <SurveyForm
              action={createSurveyAction.bind(null, orgSlug)}
              branches={data.branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
