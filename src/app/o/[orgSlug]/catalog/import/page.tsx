import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ImportForm } from "@/components/inventory/forms";
import { Alert, PageHeader } from "@/components/ui/primitives";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { importOpeningBalancesAction, importProductsAction } from "../actions";

export default async function ImportPage({ params }: PageProps<"/o/[orgSlug]/catalog/import">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const canProducts = hasPermission(ctx.grants, "catalog.manage");
  const canOpening = holdsAnyGrant(ctx.grants, "inventory.adjust");
  if (!canProducts && !canOpening) notFound();
  const t = await getTranslations("import");
  const template = (kind: string) => `/o/${orgSlug}/catalog/import/template?kind=${kind}`;
  return (
    <>
      <PageHeader title={t("title")} />
      <div className="space-y-6">
        <Alert tone="info">{t("allOrNothing")}</Alert>
        {canProducts ? (
          <ImportForm
            action={importProductsAction.bind(null, orgSlug)}
            title={t("productsTitle")}
            hint={t("productsHint")}
            templateHref={template("products")}
          />
        ) : null}
        {canOpening ? (
          <ImportForm
            action={importOpeningBalancesAction.bind(null, orgSlug)}
            title={t("openingTitle")}
            hint={t("openingHint")}
            templateHref={template("opening")}
          />
        ) : null}
      </div>
    </>
  );
}
