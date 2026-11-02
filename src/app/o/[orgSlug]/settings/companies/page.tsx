import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { CompanyForm } from "@/components/settings/company-forms";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listCompanies } from "@/modules/organizations/companies";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  archiveCompanyAction,
  createCompanyAction,
  setDefaultCompanyAction,
  updateCompanyAction,
} from "./actions";

/** The group's legal entities (ADR-082). */
export default async function CompaniesPage({
  params,
}: PageProps<"/o/[orgSlug]/settings/companies">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, companies] = await Promise.all([getTranslations("companies"), listCompanies(ctx)]);
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="space-y-6">
        <Alert tone="info">{t("phaseNote", { currency: ctx.baseCurrency })}</Alert>
        {companies.map((c) => (
          <Card
            key={c.id}
            title={`${c.code} — ${c.name}`}
            actions={
              <span className="flex flex-wrap items-center gap-2" data-testid={`company-${c.code}`}>
                {c.isDefault ? <Badge tone="success">{t("default")}</Badge> : null}
                <Badge tone="muted">{t("branchCount", { count: c._count.branches })}</Badge>
                {!c.isDefault ? (
                  <>
                    <ConfirmActionButton
                      action={setDefaultCompanyAction.bind(null, orgSlug, c.id)}
                      label={t("makeDefault")}
                      variant="secondary"
                    />
                    <ConfirmActionButton
                      action={archiveCompanyAction.bind(null, orgSlug, c.id)}
                      label={t("archive")}
                      confirmMessage={t("archiveConfirm")}
                    />
                  </>
                ) : null}
              </span>
            }
          >
            <CompanyForm
              action={updateCompanyAction.bind(null, orgSlug, c.id)}
              submitLabel={t("save")}
              defaults={{
                code: c.code,
                name: c.name,
                legalName: c.legalName,
                country: c.country,
                vatNumber: c.vatNumber,
                crNumber: c.crNumber,
              }}
            />
          </Card>
        ))}
        <Card title={t("add")}>
          <CompanyForm
            action={createCompanyAction.bind(null, orgSlug)}
            submitLabel={t("add")}
            idempotent
          />
        </Card>
      </div>
    </>
  );
}
