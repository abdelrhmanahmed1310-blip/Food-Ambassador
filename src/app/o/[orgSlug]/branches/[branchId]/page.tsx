import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { BranchForm } from "@/components/sites/branch-form";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { getBranch } from "@/modules/sites/branches";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { isUuid } from "@/lib/uuid";
import { branchFormProps } from "@/server/labels";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { setBranchArchivedAction, updateBranchAction } from "../actions";

export default async function BranchPage({
  params,
}: PageProps<"/o/[orgSlug]/branches/[branchId]">) {
  const { orgSlug, branchId } = await params;
  if (!isUuid(branchId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const branch = await notFoundOnAppError(getBranch(ctx, branchId));
  const t = await getTranslations();
  const canManage = hasPermission(ctx.grants, "branches.manage", { branchId });
  const archived = branch.archivedAt !== null;

  return (
    <>
      <PageHeader
        title={branch.name}
        description={t(`branches.types.${branch.type}`)}
        actions={
          <>
            {archived ? <Badge tone="muted">{t("common.archived")}</Badge> : null}
            <LinkButton href={`/o/${orgSlug}/warehouses?branchId=${branch.id}`} variant="secondary">
              {t("branches.viewWarehouses")}
            </LinkButton>
          </>
        }
      />
      <div className="space-y-6">
        {canManage ? (
          <Card title={t("branches.editTitle")}>
            <BranchForm
              action={updateBranchAction.bind(null, orgSlug, branch.id)}
              defaults={{
                code: branch.code,
                name: branch.name,
                type: branch.type,
                timeZone: branch.timeZone,
                addressLine: branch.addressLine,
                city: branch.city,
                country: branch.country,
              }}
              {...await branchFormProps(t("common.save"))}
            />
          </Card>
        ) : (
          <Card>
            <p className="ltr-value font-mono text-sm">{branch.code}</p>
          </Card>
        )}
        {canManage ? (
          <Card>
            <p className="text-muted mb-3 text-sm">{t("branches.archiveHint")}</p>
            {archived ? (
              <ConfirmActionButton
                action={setBranchArchivedAction.bind(null, orgSlug, branch.id, false)}
                label={t("common.restore")}
                variant="secondary"
              />
            ) : (
              <ConfirmActionButton
                action={setBranchArchivedAction.bind(null, orgSlug, branch.id, true)}
                label={t("common.archive")}
                confirmMessage={t("confirm.archiveBranch")}
              />
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
