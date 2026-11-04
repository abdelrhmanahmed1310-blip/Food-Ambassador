import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { DocumentTypeForm, RequirementForm } from "@/components/trade/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { countryOptions } from "@/lib/countries";
import { canSeeTradeDocuments, tradeSetup } from "@/modules/trade/documents";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  archiveRequirementAction,
  createDocumentTypeAction,
  createRequirementAction,
  setDocumentTypeArchivedAction,
} from "../documents/actions";

/** The organization's document types and when each is required (ADR-114). */
export default async function TradeSetupPage({ params }: PageProps<"/o/[orgSlug]/trade/setup">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeTradeDocuments(ctx)) notFound();
  const [t, locale, s] = await Promise.all([getTranslations(), getLocale(), tradeSetup(ctx)]);
  const name = (x: { name: string; nameAr: string | null }) =>
    (locale === "ar" && x.nameAr) || x.name;
  const any = t("tradeDocs.anyCountry");
  return (
    <>
      <PageHeader title={t("tradeDocs.setupTitle")} description={t("tradeDocs.setupHint")} />
      <div className="space-y-6">
        <Card title={t("tradeDocs.types")}>
          {s.types.length === 0 ? (
            <EmptyState title={t("tradeDocs.noTypes")} />
          ) : (
            <Table label={t("tradeDocs.types")}>
              <thead>
                <tr>
                  <Th>{t("tradeDocs.code")}</Th>
                  <Th>{t("tradeDocs.name")}</Th>
                  <Th>{t("tradeDocs.scope")}</Th>
                  <Th>{t("tradeDocs.hasExpiry")}</Th>
                  {s.canManage ? <Th>{""}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {s.types.map((x) => (
                  <tr key={x.id} className={x.archivedAt ? "opacity-60" : undefined}>
                    <Td>
                      <span className="ltr-value font-mono">{x.code}</span>
                    </Td>
                    <Td>
                      {name(x)}{" "}
                      {x.archivedAt ? <Badge tone="muted">{t("tradeDocs.archived")}</Badge> : null}
                    </Td>
                    <Td>{t(`tradeDocs.scopes.${x.scope}`)}</Td>
                    <Td>{x.hasExpiry ? t("common.yes") : t("common.no")}</Td>
                    {s.canManage ? (
                      <Td>
                        <ConfirmActionButton
                          action={setDocumentTypeArchivedAction.bind(
                            null,
                            orgSlug,
                            x.id,
                            !x.archivedAt,
                          )}
                          label={x.archivedAt ? t("tradeDocs.restore") : t("tradeDocs.archive")}
                          variant="secondary"
                        />
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {s.canManage ? (
            <div className="mt-4">
              <DocumentTypeForm action={createDocumentTypeAction.bind(null, orgSlug)} />
            </div>
          ) : null}
        </Card>
        <Card title={t("tradeDocs.requirements")}>
          <p className="text-muted mb-3 text-sm">{t("tradeDocs.requirementsHint")}</p>
          {s.requirements.length === 0 ? (
            <EmptyState title={t("tradeDocs.noRequirements")} />
          ) : (
            <Table label={t("tradeDocs.requirements")}>
              <thead>
                <tr>
                  <Th>{t("tradeDocs.type")}</Th>
                  <Th>{t("tradeDocs.destinationCountry")}</Th>
                  <Th>{t("tradeDocs.originCountry")}</Th>
                  <Th>{t("tradeDocs.hsPrefix")}</Th>
                  <Th>{t("tradeDocs.authority")}</Th>
                  {s.canManage ? <Th>{""}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {s.requirements.map((r) => (
                  <tr key={r.id} data-testid={`requirement-${r.documentType.code}`}>
                    <Td>
                      {r.documentType.code} — {name(r.documentType)}
                    </Td>
                    <Td>{r.destinationCountry ?? any}</Td>
                    <Td>{r.originCountry ?? any}</Td>
                    <Td>
                      <span className="ltr-value font-mono">
                        {r.hsPrefix ?? t("tradeDocs.allProducts")}
                      </span>
                    </Td>
                    <Td>{r.authority ?? "—"}</Td>
                    {s.canManage ? (
                      <Td>
                        <ConfirmActionButton
                          action={archiveRequirementAction.bind(null, orgSlug, r.id)}
                          label={t("tradeDocs.archive")}
                          variant="secondary"
                        />
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {s.canManage && s.types.some((x) => !x.archivedAt) ? (
            <div className="mt-4">
              <RequirementForm
                action={createRequirementAction.bind(null, orgSlug)}
                types={s.types
                  .filter((x) => !x.archivedAt)
                  .map((x) => ({ value: x.id, label: `${x.code} — ${name(x)}` }))}
                countries={countryOptions(locale)}
              />
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
