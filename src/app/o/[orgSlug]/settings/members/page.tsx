import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { InviteForm } from "@/components/settings/settings-forms";
import { Badge, Card, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission, isOwner } from "@/modules/access/authorize";
import { OWNER_ROLE_KEY } from "@/modules/access/permissions";
import { listRoles } from "@/modules/access/roles";
import { listMembers } from "@/modules/members/service";
import { listBranchOptions } from "@/modules/sites/branches";
import { listWarehouseOptions } from "@/modules/sites/warehouses";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { roleLabel, roleScopeLabels } from "@/server/role-labels";
import { inviteMemberAction, revokeInvitationAction } from "../actions";

export default async function MembersPage({ params }: PageProps<"/o/[orgSlug]/settings/members">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "members.view")) notFound();
  const canManage = hasPermission(ctx.grants, "members.manage");
  const [t, format, { members, invitations }] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listMembers(ctx),
  ]);
  const date = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeZone: ctx.timeZone });
  const scopeText = (g: {
    scopeType: string;
    branch: { name: string } | null;
    warehouse: { name: string } | null;
  }) =>
    g.scopeType === "BRANCH"
      ? g.branch?.name
      : g.scopeType === "WAREHOUSE"
        ? g.warehouse?.name
        : null;

  let inviteCard = null;
  if (canManage) {
    const [roles, branches, warehouses] = await Promise.all([
      listRoles(ctx),
      listBranchOptions(ctx),
      listWarehouseOptions(ctx),
    ]);
    const grantable = roles.filter((r) => r.key !== OWNER_ROLE_KEY || isOwner(ctx.grants));
    inviteCard = (
      <Card title={t("members.inviteTitle")}>
        <InviteForm
          action={inviteMemberAction.bind(null, orgSlug)}
          labels={{
            ...(await roleScopeLabels()),
            submit: t("members.invite"),
            pending: t("common.saving"),
            email: t("members.email"),
            link: t("members.invitationLink"),
            linkHint: t("members.invitationLinkHint", { email: "{email}" }),
            copy: t("common.copy"),
            copied: t("common.copied"),
          }}
          roles={grantable.map((r) => ({ value: r.id, label: roleLabel(t, r) }))}
          branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
          warehouses={warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
        />
      </Card>
    );
  }

  return (
    <>
      <PageHeader title={t("members.title")} />
      <div className="space-y-6">
        <Table label={t("members.title")}>
          <thead>
            <tr>
              <Th>{t("auth.name")}</Th>
              <Th>{t("members.rolesOf")}</Th>
              <Th>{t("members.joined")}</Th>
              {canManage ? <Th>{t("common.actions")}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <Td>
                  <p className="font-medium">
                    {m.user.name}{" "}
                    {m.id === ctx.membershipId ? <Badge>{t("members.you")}</Badge> : null}
                  </p>
                  <p className="ltr-value text-muted text-xs">{m.user.email}</p>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {m.roles.map((g) => (
                      <Badge
                        key={g.id}
                        tone={g.role.key === OWNER_ROLE_KEY ? "success" : "neutral"}
                      >
                        {roleLabel(t, g.role)}
                        {scopeText(g) ? ` · ${scopeText(g)}` : ""}
                      </Badge>
                    ))}
                  </div>
                </Td>
                <Td>{date(m.joinedAt)}</Td>
                {canManage ? (
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/settings/members/${m.id}`}
                      className="text-primary text-sm font-medium hover:underline"
                    >
                      {t("members.manage")}
                    </Link>
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>

        {inviteCard}

        {canManage ? (
          <Card title={t("members.pendingInvitations")}>
            {invitations.length === 0 ? (
              <p className="text-muted text-sm">{t("members.noPending")}</p>
            ) : (
              <ul className="divide-border divide-y">
                {invitations.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-3"
                  >
                    <div>
                      <p className="ltr-value text-sm font-medium">{inv.email}</p>
                      <p className="text-muted text-xs">
                        {roleLabel(t, inv.role)}
                        {inv.branch
                          ? ` · ${inv.branch.name}`
                          : inv.warehouse
                            ? ` · ${inv.warehouse.name}`
                            : ""}{" "}
                        · {t("members.expires", { date: date(inv.expiresAt) })}
                      </p>
                    </div>
                    <ConfirmActionButton
                      action={revokeInvitationAction.bind(null, orgSlug, inv.id)}
                      label={t("members.revoke")}
                      confirmMessage={t("confirm.revokeInvitation")}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
