import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { RoleForm } from "@/components/settings/settings-forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { permissionOptions } from "@/server/permission-options";
import { createRoleAction } from "../../actions";

export default async function NewRolePage({
  params,
}: PageProps<"/o/[orgSlug]/settings/roles/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "roles.manage")) notFound();
  const t = await getTranslations();
  return (
    <>
      <PageHeader title={t("roles.newTitle")} />
      <Card>
        <RoleForm
          action={createRoleAction.bind(null, orgSlug)}
          labels={{
            submit: t("common.create"),
            pending: t("common.saving"),
            name: t("roles.name"),
            description: t("roles.description"),
            permissions: t("roles.permissions"),
            optional: t("common.optional"),
          }}
          permissions={await permissionOptions()}
        />
      </Card>
    </>
  );
}
