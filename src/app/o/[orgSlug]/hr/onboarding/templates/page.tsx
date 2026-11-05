import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { OnboardingTemplateForm, TemplateTaskForm } from "@/components/onboarding/forms";
import { Badge, Card, PageHeader } from "@/components/ui/primitives";
import { accessibleScope } from "@/modules/access/authorize";
import { listOnboardingTemplates } from "@/modules/rosters/onboarding";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  addTemplateTaskAction,
  archiveOnboardingTemplateAction,
  createOnboardingTemplateAction,
  removeTemplateTaskAction,
} from "../actions";

/** Onboarding checklist templates (ADR-128). */
export default async function OnboardingTemplatesPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/onboarding/templates">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!accessibleScope(ctx.grants, "hr.manage").all) notFound();
  const [t, templates] = await Promise.all([
    getTranslations("onboarding"),
    listOnboardingTemplates(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("templates")} description={t("templatesHint")} />
      <div className="space-y-6">
        {templates.map((x) => (
          <Card
            key={x.id}
            title={`${x.code} — ${x.name}`}
            actions={
              x.archivedAt ? (
                <Badge tone="muted">{t("archived")}</Badge>
              ) : (
                <ConfirmActionButton
                  action={archiveOnboardingTemplateAction.bind(null, orgSlug, x.id)}
                  label={t("archive")}
                  variant="secondary"
                />
              )
            }
          >
            {x.tasks.length ? (
              <ol className="mb-4 space-y-2 text-sm">
                {x.tasks.map((task) => (
                  <li key={task.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {task.position}. {task.title}{" "}
                      <span className="text-muted">
                        ({t(`assignees.${task.assignee}`)} · {t("dueAfter", { days: task.dueDays })}
                        )
                      </span>
                    </span>
                    {!x.archivedAt ? (
                      <ConfirmActionButton
                        action={removeTemplateTaskAction.bind(null, orgSlug, task.id)}
                        label={t("remove")}
                        variant="secondary"
                      />
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-muted mb-4 text-sm">{t("noTasks")}</p>
            )}
            {!x.archivedAt ? (
              <TemplateTaskForm action={addTemplateTaskAction.bind(null, orgSlug, x.id)} />
            ) : null}
          </Card>
        ))}
        <Card title={t("createTemplate")}>
          <OnboardingTemplateForm action={createOnboardingTemplateAction.bind(null, orgSlug)} />
        </Card>
      </div>
    </>
  );
}
