import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { TemplateForm } from "@/components/foodsafety/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listRuns, listTemplates } from "@/modules/foodsafety/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createTemplateAction } from "../actions";

export default async function ChecklistsPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/checklists">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) notFound();
  const [t, format, templates, runs] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listTemplates(ctx),
    listRuns(ctx),
  ]);
  const base = `/o/${orgSlug}/food-safety`;
  return (
    <>
      <PageHeader
        title={t("foodSafety.checklistsTitle")}
        description={t("foodSafety.checklistsHint")}
      />
      <div className="space-y-6">
        {templates.length === 0 ? (
          <EmptyState title={t("foodSafety.noTemplates")} />
        ) : (
          <Card>
            <ul className="divide-border divide-y">
              {templates.map((tpl) => (
                <li
                  key={tpl.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <Link
                    href={`${base}/checklists/${tpl.id}`}
                    className="text-primary font-medium hover:underline"
                  >
                    {tpl.name}
                  </Link>
                  <span className="text-muted">
                    {t("foodSafety.itemsRuns", { items: tpl._count.items, runs: tpl._count.runs })}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {holdsAnyGrant(ctx.grants, "foodsafety.manage") ? (
          <Card title={t("foodSafety.newTemplate")}>
            <TemplateForm action={createTemplateAction.bind(null, orgSlug)} />
          </Card>
        ) : null}
        {runs.length > 0 ? (
          <Card title={t("foodSafety.recentRuns")}>
            <Table label={t("foodSafety.recentRuns")}>
              <thead>
                <tr>
                  <Th>{t("common.date")}</Th>
                  <Th>{t("foodSafety.checklist")}</Th>
                  <Th>{t("foodSafety.branch")}</Th>
                  <Th>{t("common.status")}</Th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap">
                      <Link href={`${base}/runs/${r.id}`} className="text-primary hover:underline">
                        {format.dateTime(r.completedAt, {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: ctx.timeZone,
                        })}
                      </Link>
                    </Td>
                    <Td>{r.template.name}</Td>
                    <Td>
                      <span className="ltr-value font-mono text-xs">{r.branch.code}</span>
                    </Td>
                    <Td>
                      {r.failedCount === 0 ? (
                        <Badge tone="success">{t("foodSafety.allPassed")}</Badge>
                      ) : (
                        <Badge tone="danger">
                          {t("foodSafety.failedCount", { count: r.failedCount })}
                        </Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : null}
      </div>
    </>
  );
}
