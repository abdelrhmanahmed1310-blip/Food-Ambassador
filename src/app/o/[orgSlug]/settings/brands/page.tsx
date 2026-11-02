import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { BrandForm } from "@/components/settings/company-forms";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listBrands } from "@/modules/organizations/companies";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { archiveBrandAction, createBrandAction } from "../companies/actions";

/** Brands group branches commercially (ADR-082). */
export default async function BrandsPage({ params }: PageProps<"/o/[orgSlug]/settings/brands">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, brands] = await Promise.all([getTranslations("companies"), listBrands(ctx)]);
  return (
    <>
      <PageHeader title={t("brands")} description={t("brandsIntro")} />
      <div className="space-y-6">
        {brands.length === 0 ? (
          <EmptyState title={t("noBrands")} />
        ) : (
          <Table label={t("brands")}>
            <thead>
              <tr>
                <Th>{t("code")}</Th>
                <Th>{t("brandName")}</Th>
                <Th>{t("branches")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {brands.map((b) => (
                <tr key={b.id} data-testid="brand-row">
                  <Td className="ltr-value font-mono">{b.code}</Td>
                  <Td>
                    {b.name}
                    {b.nameAr ? <span className="text-muted block text-xs">{b.nameAr}</span> : null}
                  </Td>
                  <Td className="tabular-nums">{b._count.branches}</Td>
                  <Td>
                    <ConfirmActionButton
                      action={archiveBrandAction.bind(null, orgSlug, b.id)}
                      label={t("archive")}
                      confirmMessage={t("archiveBrandConfirm")}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Card title={t("addBrand")}>
          <BrandForm action={createBrandAction.bind(null, orgSlug)} />
        </Card>
      </div>
    </>
  );
}
