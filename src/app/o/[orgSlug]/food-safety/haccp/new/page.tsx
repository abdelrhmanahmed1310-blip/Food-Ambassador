import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { HaccpPlanForm } from "@/components/foodsafety/haccp-forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { branchOptions } from "@/modules/foodsafety/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createPlanAction } from "../actions";

export default async function NewHaccpPlanPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/haccp/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.manage")) notFound();
  const [t, branches] = await Promise.all([
    getTranslations(),
    branchOptions(ctx, "foodsafety.manage"),
  ]);
  return (
    <>
      <PageHeader title={t("haccp.newTitle")} description={t("haccp.hint")} />
      <Card>
        <HaccpPlanForm
          action={createPlanAction.bind(null, orgSlug)}
          branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
        />
        {!hasPermission(ctx.grants, "foodsafety.manage") ? (
          <p className="text-muted mt-3 text-xs">{t("haccp.branchOnlyHint")}</p>
        ) : null}
      </Card>
    </>
  );
}
