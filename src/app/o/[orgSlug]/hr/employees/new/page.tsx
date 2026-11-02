import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmployeeForm } from "@/components/hr/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { employeeFormOptions } from "@/modules/hr/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createEmployeeAction } from "../../actions";
import { optionsFor } from "../options";

export default async function NewEmployeePage({
  params,
}: PageProps<"/o/[orgSlug]/hr/employees/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "hr.manage")) notFound();
  const [t, options] = await Promise.all([getTranslations(), employeeFormOptions(ctx)]);
  return (
    <>
      <PageHeader title={t("hr.newEmployee")} description={t("hr.newEmployeeIntro")} />
      <Card>
        <EmployeeForm
          action={createEmployeeAction.bind(null, orgSlug)}
          submitLabel={t("common.create")}
          idempotent
          {...optionsFor(options)}
        />
      </Card>
    </>
  );
}
