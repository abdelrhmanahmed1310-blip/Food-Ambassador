import { getTranslations } from "next-intl/server";
import { BranchForm } from "@/components/sites/branch-form";
import { Card, PageHeader } from "@/components/ui/primitives";
import { notFound } from "next/navigation";
import { hasPermission } from "@/modules/access/authorize";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { branchFormProps } from "@/server/labels";
import { createBranchAction } from "../actions";

export default async function NewBranchPage({ params }: PageProps<"/o/[orgSlug]/branches/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "branches.manage")) notFound();
  const t = await getTranslations();
  return (
    <>
      <PageHeader title={t("branches.newTitle")} />
      <Card>
        <BranchForm
          action={createBranchAction.bind(null, orgSlug)}
          idempotent
          {...await branchFormProps(t("common.create"))}
        />
      </Card>
    </>
  );
}
