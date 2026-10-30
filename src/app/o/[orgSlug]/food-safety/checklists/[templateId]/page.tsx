import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ItemForm, RunForm } from "@/components/foodsafety/forms";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { branchOptions, getTemplate } from "@/modules/foodsafety/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  addChecklistItemAction,
  completeChecklistAction,
  removeChecklistItemAction,
} from "../../actions";

export default async function TemplatePage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/checklists/[templateId]">) {
  const { orgSlug, templateId } = await params;
  if (!isUuid(templateId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const tpl = await notFoundOnAppError(getTemplate(ctx, templateId));
  const manage = holdsAnyGrant(ctx.grants, "foodsafety.manage");
  const canRun = holdsAnyGrant(ctx.grants, "foodsafety.record");
  const [t, branches] = await Promise.all([
    getTranslations(),
    canRun ? branchOptions(ctx, "foodsafety.record") : Promise.resolve([]),
  ]);
  const range = (min: { toFixed(): string } | null, max: { toFixed(): string } | null) =>
    min && max
      ? `${min.toFixed()} – ${max.toFixed()}`
      : min
        ? `≥ ${min.toFixed()}`
        : max
          ? `≤ ${max.toFixed()}`
          : null;
  return (
    <>
      <PageHeader title={tpl.name} description={tpl.description ?? undefined} />
      <div className="space-y-6">
        <Card title={t("foodSafety.items")}>
          {tpl.items.length === 0 ? (
            <EmptyState title={t("foodSafety.noItems")} />
          ) : (
            <ol className="divide-border list-decimal divide-y ps-5 text-sm">
              {tpl.items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {i.text}{" "}
                    <span className="text-muted">· {t(`foodSafety.answerKinds.${i.kind}`)}</span>
                    {range(i.minValue, i.maxValue) ? (
                      <span className="ltr-value text-muted">
                        {" "}
                        ({range(i.minValue, i.maxValue)})
                      </span>
                    ) : null}
                  </span>
                  {manage ? (
                    <ConfirmActionButton
                      action={removeChecklistItemAction.bind(null, orgSlug, tpl.id, i.id)}
                      label={t("common.remove")}
                      variant="secondary"
                    />
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {manage ? (
            <div className="mt-4">
              <ItemForm action={addChecklistItemAction.bind(null, orgSlug, tpl.id)} />
            </div>
          ) : null}
        </Card>
        {canRun && tpl.items.length > 0 ? (
          <Card title={t("foodSafety.runChecklist")}>
            <RunForm
              action={completeChecklistAction.bind(null, orgSlug, tpl.id)}
              branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
              items={tpl.items.map((i) => ({
                id: i.id,
                text: i.text,
                kind: i.kind,
                range: range(i.minValue, i.maxValue),
              }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
