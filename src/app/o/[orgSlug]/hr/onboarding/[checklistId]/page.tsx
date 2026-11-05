import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CancelChecklistForm } from "@/components/onboarding/forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Badge, Card, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getChecklist } from "@/modules/rosters/onboarding";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { cancelChecklistAction, tickTaskAction } from "../actions";

/** One onboarding checklist: HR, the line manager and the new hire tick their tasks (ADR-128). */
export default async function ChecklistPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/onboarding/[checklistId]">) {
  const { orgSlug, checklistId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!isUuid(checklistId)) notFound();
  const [t, r] = await Promise.all([getTranslations("onboarding"), getChecklist(ctx, checklistId)]);
  const c = r.checklist;
  return (
    <>
      <PageHeader
        title={`${c.employee.firstName} ${c.employee.lastName} · ${c.template.name}`}
        description={`${c.employee.number} · ${c.employee.jobTitle} · ${t("startedOnValue", { date: c.startedOn.toISOString().slice(0, 10) })}`}
        actions={
          c.completedAt ? (
            <Badge tone="success">{t("completed")}</Badge>
          ) : c.cancelledAt ? (
            <Badge tone="muted">{t("cancelled")}</Badge>
          ) : (
            <Badge tone="warning">{t("open")}</Badge>
          )
        }
      />
      <div className="space-y-6">
        <Card title={t("tasks")}>
          <ol className="space-y-3 text-sm">
            {r.tasks.map((task) => (
              <li
                key={task.id}
                className="flex flex-wrap items-center justify-between gap-2"
                data-testid="onboarding-task"
              >
                <span>
                  <span className={task.doneAt ? "line-through" : "font-medium"}>{task.title}</span>{" "}
                  <span className="text-muted">
                    ({t(`assignees.${task.assignee}`)} ·{" "}
                    {t("dueOn", { date: task.dueOn.toISOString().slice(0, 10) })})
                  </span>{" "}
                  {task.doneAt ? (
                    <Badge tone="success">{t("done")}</Badge>
                  ) : task.overdue ? (
                    <Badge tone="danger">{t("overdue")}</Badge>
                  ) : null}
                  {task.note ? <span className="text-muted block text-xs">{task.note}</span> : null}
                </span>
                {task.mayTick ? (
                  <ConfirmActionButton
                    action={tickTaskAction.bind(null, orgSlug, task.id, !task.doneAt)}
                    label={task.doneAt ? t("undo") : t("markDone", { title: task.title })}
                    variant={task.doneAt ? "secondary" : "primary"}
                  />
                ) : null}
              </li>
            ))}
          </ol>
        </Card>
        {c.cancelReason ? <p className="text-muted text-sm">{c.cancelReason}</p> : null}
        {r.can.cancel ? (
          <CancelChecklistForm action={cancelChecklistAction.bind(null, orgSlug, c.id)} />
        ) : null}
      </div>
    </>
  );
}
