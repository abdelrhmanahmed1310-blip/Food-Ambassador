import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ActionForm } from "@/components/forms/fields";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Alert, Badge, Card, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { OtpForm, ZatcaSettingsForm } from "@/components/zatca/forms";
import { hasPermission } from "@/modules/access/authorize";
import { getZatcaSetup } from "@/modules/zatca/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { buttonClass, inputClass } from "@/components/ui/styles";
import {
  onboardDeviceAction,
  prepareDeviceAction,
  prepareOfficeUnitAction,
  reportNowAction,
  updateZatcaSettingsAction,
} from "./actions";

const tone = {
  NEW: "muted",
  COMPLIANCE: "warning",
  ACTIVE: "success",
  RETIRED: "muted",
  PENDING: "warning",
  REPORTED: "success",
  REPORTED_WITH_WARNINGS: "warning",
  CLEARED: "success",
  CLEARED_WITH_WARNINGS: "warning",
  REJECTED: "danger",
} as const;

/** ZATCA e-invoicing for Saudi Arabia (ADR-064), one company at a time (ADR-085). */
export default async function ZatcaPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/settings/zatca">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const sp = await searchParams;
  const companyParam = (Array.isArray(sp.company) ? sp.company[0] : sp.company) || null;
  const [t, format, setup] = await Promise.all([
    getTranslations(),
    getFormatter(),
    getZatcaSetup(ctx, companyParam),
  ]);
  const companyId = setup.company.id;
  const ready = setup.vatRegistered && setup.country === "SA" && ctx.baseCurrency === "SAR";
  const s = setup.settings;
  return (
    <>
      <PageHeader title={t("zatca.title")} description={t("zatca.intro")} />
      <div className="space-y-6">
        <Alert tone="info">{t("zatca.validationNote")}</Alert>
        {setup.companies.length > 1 ? (
          <form method="get" className="flex items-center gap-2" data-testid="zatca-company">
            <label htmlFor="company" className="text-sm font-medium">
              {t("zatca.company")}
            </label>
            <select
              id="company"
              name="company"
              defaultValue={companyId}
              className={`${inputClass} w-auto`}
            >
              {setup.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
            <button type="submit" className={buttonClass("secondary")}>
              {t("zatca.showCompany")}
            </button>
          </form>
        ) : null}
        {!ready ? <Alert tone="error">{t("zatca.notReady")}</Alert> : null}
        <Card title={`${t("zatca.seller")} — ${setup.company.name}`}>
          <ZatcaSettingsForm
            action={updateZatcaSettingsAction.bind(null, orgSlug, companyId)}
            defaults={
              s
                ? {
                    legalName: s.legalName,
                    crNumber: s.crNumber,
                    street: s.street,
                    building: s.building,
                    district: s.district,
                    city: s.city,
                    postalCode: s.postalCode,
                    businessCategory: s.businessCategory,
                    environment: s.environment,
                  }
                : {
                    // The company's own registration details to start from.
                    legalName: setup.company.legalName,
                    crNumber: setup.company.crNumber,
                  }
            }
          />
        </Card>
        <Card title={t("zatca.units")}>
          <p className="text-muted mb-3 text-sm">{t("zatca.unitsIntro")}</p>
          {setup.registers.length === 0 ? (
            <p className="text-muted text-sm">{t("zatca.noRegisters")}</p>
          ) : (
            <ul className="divide-border divide-y">
              {setup.registers.map((r) => {
                const d = r.zatcaDevice;
                return (
                  <li key={r.id} className="space-y-2 py-3" data-testid={`unit-${r.code}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <span className="ltr-value font-mono">{r.code}</span> — {r.name} ·{" "}
                        {r.branch.name}
                      </span>
                      <span className="flex items-center gap-2">
                        {d ? (
                          <Badge tone={tone[d.status]}>
                            {t(`zatca.deviceStatuses.${d.status}`)}
                          </Badge>
                        ) : (
                          <Badge tone="muted">{t("zatca.noUnit")}</Badge>
                        )}
                        {d?.status === "ACTIVE" ? (
                          <span className="text-muted text-xs">
                            {t("zatca.documentsIssued", { count: d.icv })} ·{" "}
                            {t(`zatca.environments.${d.environment}`)}
                          </span>
                        ) : null}
                      </span>
                    </div>
                    {ready && s && (!d || d.status === "NEW") ? (
                      <ConfirmActionButton
                        action={prepareDeviceAction.bind(null, orgSlug, r.id)}
                        label={d ? t("zatca.remakeKey") : t("zatca.prepare")}
                        variant="secondary"
                      />
                    ) : null}
                    {d && (d.status === "NEW" || d.status === "COMPLIANCE") ? (
                      <OtpForm action={onboardDeviceAction.bind(null, orgSlug, d.id)} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title={t("zatca.officeUnit")}>
          <p className="text-muted mb-3 text-sm">{t("zatca.officeUnitIntro")}</p>
          <div className="space-y-2" data-testid="unit-OFFICE">
            <div className="flex flex-wrap items-center gap-2">
              {setup.office ? (
                <Badge tone={tone[setup.office.status]}>
                  {t(`zatca.deviceStatuses.${setup.office.status}`)}
                </Badge>
              ) : (
                <Badge tone="muted">{t("zatca.noUnit")}</Badge>
              )}
              {setup.office?.status === "ACTIVE" ? (
                <span className="text-muted text-xs">
                  {t("zatca.documentsIssued", { count: setup.office.icv })} ·{" "}
                  {t(`zatca.environments.${setup.office.environment}`)}
                </span>
              ) : null}
            </div>
            {ready && s && (!setup.office || setup.office.status === "NEW") ? (
              <ConfirmActionButton
                action={prepareOfficeUnitAction.bind(null, orgSlug, companyId)}
                label={setup.office ? t("zatca.remakeKey") : t("zatca.prepare")}
                variant="secondary"
              />
            ) : null}
            {setup.office &&
            (setup.office.status === "NEW" || setup.office.status === "COMPLIANCE") ? (
              <OtpForm action={onboardDeviceAction.bind(null, orgSlug, setup.office.id)} />
            ) : null}
          </div>
        </Card>
        <Card title={t("zatca.documents")}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span data-testid="zatca-counts">
              {(["PENDING", "REPORTED", "REPORTED_WITH_WARNINGS", "REJECTED"] as const)
                .map((k) => `${t(`zatca.statuses.${k}`)}: ${setup.counts[k] ?? 0}`)
                .join(" · ")}
            </span>
            <ActionForm
              action={reportNowAction.bind(null, orgSlug)}
              submitLabel={t("zatca.reportNow")}
              pendingLabel={t("common.saving")}
              submitVariant="secondary"
              className="flex items-center gap-2"
            >
              {null}
            </ActionForm>
          </div>
          {setup.documents.length === 0 ? (
            <p className="text-muted text-sm">{t("zatca.noDocuments")}</p>
          ) : (
            <Table label={t("zatca.documents")}>
              <thead>
                <tr>
                  <Th>{t("zatca.number")}</Th>
                  <Th>{t("zatca.type")}</Th>
                  <Th>ICV</Th>
                  <Th>{t("zatca.issued")}</Th>
                  <Th>{t("zatca.status")}</Th>
                </tr>
              </thead>
              <tbody>
                {setup.documents.map((d) => (
                  <tr key={d.id}>
                    <Td className="ltr-value font-mono">{d.number}</Td>
                    <Td>{t(`zatca.types.${d.type}`)}</Td>
                    <Td className="tabular-nums">{d.icv}</Td>
                    <Td className="ltr-value">
                      {format.dateTime(d.createdAt, {
                        dateStyle: "short",
                        timeStyle: "short",
                        timeZone: ctx.timeZone,
                      })}
                    </Td>
                    <Td>
                      <Badge tone={tone[d.status]}>{t(`zatca.statuses.${d.status}`)}</Badge>
                      {d.attempts > 1 ? (
                        <span className="text-muted ms-1 text-xs">
                          {t("zatca.attempts", { count: d.attempts })}
                        </span>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
