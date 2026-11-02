import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { LeaveTypeForm } from "@/components/hr/leave-forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listLeaveTypes } from "@/modules/hr/leave";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { addCommonTypesAction, archiveLeaveTypeAction, createLeaveTypeAction } from "../actions";

/** Leave types (ADR-081): common ones with one click; entitlements are set per employee. */
export default async function LeaveTypesPage({ params }: PageProps<"/o/[orgSlug]/hr/leave/types">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "hr.manage")) notFound();
  const [t, types] = await Promise.all([getTranslations("leave"), listLeaveTypes(ctx)]);
  return (
    <>
      <PageHeader
        title={t("types")}
        description={t("typesIntro")}
        actions={
          <ConfirmActionButton
            action={addCommonTypesAction.bind(null, orgSlug)}
            label={t("addCommon")}
            variant="secondary"
          />
        }
      />
      <div className="space-y-6">
        {types.length === 0 ? (
          <EmptyState title={t("noTypes")} />
        ) : (
          <Table label={t("types")}>
            <thead>
              <tr>
                <Th>{t("code")}</Th>
                <Th>{t("name")}</Th>
                <Th>{t("country")}</Th>
                <Th>{t("paid")}</Th>
                <Th>{t("usesBalance")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {types.map((ty) => (
                <tr key={ty.id} data-testid="leave-type">
                  <Td className="ltr-value font-mono">{ty.code}</Td>
                  <Td>
                    {ty.name}
                    {ty.nameAr ? (
                      <span className="text-muted block text-xs">{ty.nameAr}</span>
                    ) : null}
                  </Td>
                  <Td className="ltr-value">{ty.country ?? t("allCountries")}</Td>
                  <Td>
                    {ty.paid ? (
                      <Badge tone="success">{t("yes")}</Badge>
                    ) : (
                      <Badge tone="muted">{t("no")}</Badge>
                    )}
                  </Td>
                  <Td>{ty.usesBalance ? t("yes") : t("no")}</Td>
                  <Td>
                    <ConfirmActionButton
                      action={archiveLeaveTypeAction.bind(null, orgSlug, ty.id)}
                      label={t("archive")}
                      confirmMessage={t("archiveConfirm")}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Card title={t("addType")}>
          <LeaveTypeForm action={createLeaveTypeAction.bind(null, orgSlug)} />
        </Card>
      </div>
    </>
  );
}
