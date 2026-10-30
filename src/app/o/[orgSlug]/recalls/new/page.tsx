import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { NewRecallForm } from "@/components/traceability/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createRecallAction } from "../actions";

export default async function NewRecallPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/recalls/new">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "recalls.manage")) notFound();
  const lotId = typeof sp.lotId === "string" && isUuid(sp.lotId) ? sp.lotId : undefined;
  const t = await getTranslations();
  return (
    <>
      <PageHeader title={t("recalls.newTitle")} description={t("recalls.newHint")} />
      <Card>
        <NewRecallForm action={createRecallAction.bind(null, orgSlug, lotId)} />
      </Card>
    </>
  );
}
