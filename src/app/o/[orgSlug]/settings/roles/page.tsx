import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listRoles } from "@/modules/access/roles";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { roleLabel } from "@/server/role-labels";

export default async function RolesPage({ params }: PageProps<"/o/[orgSlug]/settings/roles">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "roles.manage")) notFound();
  const [t, roles] = await Promise.all([getTranslations(), listRoles(ctx)]);
  const base = `/o/${orgSlug}/settings/roles`;
  return (
    <>
      <PageHeader
        title={t("roles.title")}
        description={t("roles.scopeNote")}
        actions={<LinkButton href={`${base}/new`}>{t("roles.new")}</LinkButton>}
      />
      <Table label={t("roles.title")}>
        <thead>
          <tr>
            <Th>{t("roles.name")}</Th>
            <Th>{t("roles.permissions")}</Th>
            <Th>{t("common.details")}</Th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id}>
              <Td>
                <Link href={`${base}/${r.id}`} className="text-primary font-medium hover:underline">
                  {roleLabel(t, r)}
                </Link>{" "}
                <Badge tone="muted">{r.isSystem ? t("roles.system") : t("roles.custom")}</Badge>
              </Td>
              <Td className="tabular-nums">{r.permissions.length}</Td>
              <Td className="text-muted">
                {t("roles.assignments", { count: r._count.membershipRoles })}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
