import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { RoleForm } from "@/components/settings/settings-forms";
import { Alert, Card, LinkButton, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { getRole } from "@/modules/access/roles";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { permissionOptions } from "@/server/permission-options";
import { roleLabel } from "@/server/role-labels";
import { updateRoleAction } from "../../actions";

export default async function RolePage({
  params,
}: PageProps<"/o/[orgSlug]/settings/roles/[roleId]">) {
  const { orgSlug, roleId } = await params;
  if (!isUuid(roleId)) notFound();
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "roles.manage")) notFound();
  const role = await notFoundOnAppError(getRole(ctx, roleId));
  const t = await getTranslations();
  return (
    <>
      <PageHeader
        title={roleLabel(t, role)}
        actions={
          <LinkButton href={`/o/${orgSlug}/settings/roles`} variant="secondary">
            {t("common.back")}
          </LinkButton>
        }
      />
      <div className="space-y-4">
        {!role.editable ? <Alert tone="info">{t("roles.ownerLocked")}</Alert> : null}
        <Card title={t("roles.editTitle")}>
          <RoleForm
            action={updateRoleAction.bind(null, orgSlug, role.id)}
            labels={{
              submit: t("common.save"),
              pending: t("common.saving"),
              name: t("roles.name"),
              description: t("roles.description"),
              permissions: t("roles.permissions"),
              optional: t("common.optional"),
            }}
            permissions={await permissionOptions()}
            defaults={{
              name: roleLabel(t, role),
              description: role.description ?? "",
              permissions: role.permissions,
            }}
            disabled={!role.editable}
          />
        </Card>
      </div>
    </>
  );
}
