import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { NewDocumentForm } from "@/components/foodsafety/document-forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { branchOptions } from "@/modules/foodsafety/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createDocumentAction } from "../actions";

export default async function NewDocumentPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/documents/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.manage")) notFound();
  const [t, branches] = await Promise.all([
    getTranslations(),
    branchOptions(ctx, "foodsafety.manage"),
  ]);
  return (
    <>
      <PageHeader title={t("fsDocs.newTitle")} description={t("fsDocs.hint")} />
      <Card>
        <NewDocumentForm
          action={createDocumentAction.bind(null, orgSlug)}
          branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
        />
      </Card>
    </>
  );
}
