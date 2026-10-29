import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { GrantRoleForm } from "@/components/settings/settings-forms";
import { Card, LinkButton, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission, isOwner } from "@/modules/access/authorize";
import { OWNER_ROLE_KEY } from "@/modules/access/permissions";
import { listRoles } from "@/modules/access/roles";
import { listMembers } from "@/modules/members/service";
import { listBranchOptions } from "@/modules/sites/branches";
import { listWarehouseOptions } from "@/modules/sites/warehouses";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { roleLabel, roleScopeLabels } from "@/server/role-labels";
import { grantRoleAction, removeMemberAction, revokeRoleAction } from "../../actions";

export default async function MemberPage({
  params,
}: PageProps<"/o/[orgSlug]/settings/members/[membershipId]">) {
  const { orgSlug, membershipId } = await params;
  if (!isUuid(membershipId)) notFound();
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "members.manage")) notFound();
  const [t, { members }, roles, branches, warehouses] = await Promise.all([
    getTranslations(),
    listMembers(ctx),
    listRoles(ctx),
    listBranchOptions(ctx),
    listWarehouseOptions(ctx),
  ]);
  const member = members.find((m) => m.id === membershipId);
  if (!member) notFound();
  const owner = isOwner(ctx.grants);
  const isSelf = member.id === ctx.membershipId;

  return (
    <>
      <PageHeader
        title={member.user.name}
        description={member.user.email}
        actions={
          <LinkButton href={`/o/${orgSlug}/settings/members`} variant="secondary">
            {t("common.back")}
          </LinkButton>
        }
      />
      <div className="space-y-6">
        <Card title={t("members.rolesOf")}>
          <ul className="divide-border divide-y">
            {member.roles.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-sm font-medium">{roleLabel(t, g.role)}</p>
                  <p className="text-muted text-xs">
                    {t(`members.scopeTypes.${g.scopeType}`)}
                    {g.branch ? ` · ${g.branch.name}` : g.warehouse ? ` · ${g.warehouse.name}` : ""}
                  </p>
                </div>
                {g.role.key !== OWNER_ROLE_KEY || owner ? (
                  <ConfirmActionButton
                    action={revokeRoleAction.bind(null, orgSlug, member.id, g.id)}
                    label={t("members.revokeRole")}
                    confirmMessage={t("confirm.revokeRole")}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t("members.grant")}>
          <GrantRoleForm
            action={grantRoleAction.bind(null, orgSlug, member.id)}
            labels={{
              ...(await roleScopeLabels()),
              submit: t("members.grant"),
              pending: t("common.saving"),
            }}
            roles={roles
              .filter((r) => r.key !== OWNER_ROLE_KEY || owner)
              .map((r) => ({ value: r.id, label: roleLabel(t, r) }))}
            branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
            warehouses={warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
          />
        </Card>
        {!isSelf ? (
          <Card>
            <ConfirmActionButton
              action={removeMemberAction.bind(null, orgSlug, member.id)}
              label={t("members.remove")}
              confirmMessage={t("members.removeConfirm", { name: member.user.name })}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
