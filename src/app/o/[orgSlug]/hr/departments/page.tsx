import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { DepartmentForm } from "@/components/hr/forms";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { canViewHr, listDepartments } from "@/modules/hr/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { archiveDepartmentAction, createDepartmentAction } from "../actions";

export default async function DepartmentsPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/departments">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewHr(ctx)) notFound();
  const [t, departments] = await Promise.all([getTranslations(), listDepartments(ctx)]);
  const manage = hasPermission(ctx.grants, "hr.manage");
  return (
    <>
      <PageHeader title={t("hr.departments")} description={t("hr.departmentsIntro")} />
      <div className="space-y-6">
        {departments.length === 0 ? (
          <EmptyState title={t("hr.noDepartments")} />
        ) : (
          <Table label={t("hr.departments")}>
            <thead>
              <tr>
                <Th>{t("hr.code")}</Th>
                <Th>{t("hr.departmentName")}</Th>
                <Th>{t("hr.parentDepartment")}</Th>
                <Th>{t("hr.headcount")}</Th>
                {manage ? <Th /> : null}
              </tr>
            </thead>
            <tbody>
              {departments.map((d) => (
                <tr key={d.id} data-testid="department-row">
                  <Td className="ltr-value font-mono">{d.code}</Td>
                  <Td>
                    {d.name}
                    {d.nameAr ? <span className="text-muted block text-xs">{d.nameAr}</span> : null}
                  </Td>
                  <Td>{d.parent?.name ?? "—"}</Td>
                  <Td className="tabular-nums">{d._count.employees}</Td>
                  {manage ? (
                    <Td>
                      <ConfirmActionButton
                        action={archiveDepartmentAction.bind(null, orgSlug, d.id)}
                        label={t("hr.archive")}
                        confirmMessage={t("hr.archiveDepartmentConfirm")}
                      />
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {manage ? (
          <Card title={t("hr.addDepartment")}>
            <DepartmentForm
              action={createDepartmentAction.bind(null, orgSlug)}
              parents={departments.map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
