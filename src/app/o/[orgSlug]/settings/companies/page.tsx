import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { CompanyForm } from "@/components/settings/company-forms";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { currencyChoices } from "@/modules/fx/rules";
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
  const currencies = currencyChoices(ctx.groupCurrency);
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="space-y-6">
        <Alert tone="info">{t("phaseNote", { currency: ctx.groupCurrency })}</Alert>
        {companies.map((c) => (
          <Card
            key={c.id}
            title={`${c.code} — ${c.name}`}
            actions={
              <span className="flex flex-wrap items-center gap-2" data-testid={`company-${c.code}`}>
                {c.isDefault ? <Badge tone="success">{t("default")}</Badge> : null}
                <Badge tone="muted">{c.currency}</Badge>
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
              isDefault={c.isDefault}
              currencies={currencies}
              vatRegistered={c.vatRegistered}
              defaults={{
                code: c.code,
                name: c.name,
                legalName: c.legalName,
                country: c.country,
                vatNumber: c.vatNumber,
                crNumber: c.crNumber,
                currency: c.currency,
              }}
            />
          </Card>
        ))}
        <Card title={t("add")}>
          <CompanyForm
            action={createCompanyAction.bind(null, orgSlug)}
            submitLabel={t("add")}
            currencies={currencies}
            idempotent
          />
        </Card>
      </div>
    </>
  );
}
