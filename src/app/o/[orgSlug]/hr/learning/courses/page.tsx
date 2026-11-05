import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { CourseForm, RequirementForm } from "@/components/learning/forms";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { canViewTraining, listCourses } from "@/modules/learning/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  addRequirementAction,
  archiveCourseAction,
  createCourseAction,
  removeRequirementAction,
} from "../actions";

/** The course catalogue and who must hold each course (ADR-125). */
export default async function CoursesPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/learning/courses">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewTraining(ctx)) notFound();
  const [t, locale, data] = await Promise.all([
    getTranslations("learning"),
    getLocale(),
    listCourses(ctx),
  ]);
  const dept = new Map(data.departments.map((d) => [d.id, `${d.code} — ${d.name}`]));
  const branch = new Map(data.branches.map((b) => [b.id, `${b.code} — ${b.name}`]));
  const who = (r: (typeof data.courses)[number]["requirements"][number]) =>
    r.scope === "ALL"
      ? t("scopes.ALL")
      : r.scope === "JOB_TITLE"
        ? `${t("scopes.JOB_TITLE")}: ${r.jobTitle}`
        : r.scope === "DEPARTMENT"
          ? `${t("scopes.DEPARTMENT")}: ${dept.get(r.departmentId!) ?? "—"}`
          : `${t("scopes.BRANCH")}: ${branch.get(r.branchId!) ?? "—"}`;
  return (
    <>
      <PageHeader title={t("coursesTitle")} description={t("coursesHint")} />
      <div className="space-y-6">
        {data.courses.length === 0 ? <EmptyState title={t("noCourses")} /> : null}
        {data.courses.map((c) => (
          <Card key={c.id} title={`${c.code} — ${(locale === "ar" && c.nameAr) || c.name}`}>
            <div className="space-y-3 text-sm" data-testid={`course-${c.code}`}>
              <p className="flex flex-wrap gap-2">
                <Badge tone="neutral">{t(`categories.${c.category}`)}</Badge>
                <Badge tone="muted">{t(`deliveries.${c.delivery}`)}</Badge>
                <Badge tone="muted">
                  {c.validityMonths ? t("validFor", { months: c.validityMonths }) : t("noExpiry")}
                </Badge>
                <span className="text-muted">{t("recordsCount", { count: c._count.records })}</span>
              </p>
              {c.requirements.length === 0 ? (
                <p className="text-muted">{t("notRequired")}</p>
              ) : (
                <ul className="space-y-1">
                  {c.requirements.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {who(r)} · {t("dueAfterHire", { days: r.dueWithinDays })}
                      </span>
                      {data.canManage ? (
                        <ConfirmActionButton
                          action={removeRequirementAction.bind(null, orgSlug, r.id)}
                          label={t("remove")}
                          variant="secondary"
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {data.canManage ? (
                <details>
                  <summary className="text-primary cursor-pointer">{t("addRequirement")}</summary>
                  <div className="mt-3">
                    <RequirementForm
                      action={addRequirementAction.bind(null, orgSlug, c.id)}
                      departments={data.departments.map((d) => ({
                        value: d.id,
                        label: `${d.code} — ${d.name}`,
                      }))}
                      branches={data.branches.map((b) => ({
                        value: b.id,
                        label: `${b.code} — ${b.name}`,
                      }))}
                    />
                  </div>
                </details>
              ) : null}
              {data.canManage ? (
                <ConfirmActionButton
                  action={archiveCourseAction.bind(null, orgSlug, c.id, true)}
                  label={t("archive")}
                  variant="secondary"
                />
              ) : null}
            </div>
          </Card>
        ))}
        {data.canManage ? (
          <Card title={t("addCourse")}>
            <CourseForm action={createCourseAction.bind(null, orgSlug)} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
