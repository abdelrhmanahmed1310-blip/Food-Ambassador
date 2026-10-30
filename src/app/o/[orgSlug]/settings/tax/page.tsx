import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { PresetForm, TaxCodeForm, TaxRateForm, TaxSettingsForm } from "@/components/tax/forms";
import { Alert, Badge, Card, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { PRESETS, TAX_COUNTRIES } from "@/modules/tax/presets";
import { getTaxSetup } from "@/modules/tax/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  addTaxRateAction,
  applyPresetAction,
  createTaxCodeAction,
  updateTaxSettingsAction,
} from "./actions";

export default async function TaxSettingsPage({ params }: PageProps<"/o/[orgSlug]/settings/tax">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, locale, setup] = await Promise.all([getTranslations(), getLocale(), getTaxSetup(ctx)]);
  const names = new Intl.DisplayNames([locale], { type: "region" });
  const countries = TAX_COUNTRIES.map((c) => ({
    value: c,
    label: `${names.of(c)}${PRESETS[c].vatInForce ? "" : ` — ${t("tax.noVatInForce")}`}`,
  }));
  const s = setup.settings;
  const codeLabel = (c: (typeof setup.codes)[number]) =>
    `${c.code} — ${(locale === "ar" && c.nameAr) || c.name}`;
  const pct = (r: { toString(): string }) =>
    `${(Number(r.toString()) * 100).toLocaleString("en", { maximumFractionDigits: 4 })} %`;
  const preset = s?.country ? PRESETS[s.country as keyof typeof PRESETS] : null;
  return (
    <>
      <PageHeader title={t("tax.title")} description={t("tax.hint")} />
      <div className="space-y-6">
        <Alert tone="info">{t("tax.disclaimer")}</Alert>
        <Card title={t("tax.presetTitle")}>
          <p className="text-muted mb-3 text-sm">{t("tax.presetHint")}</p>
          <PresetForm
            action={applyPresetAction.bind(null, orgSlug)}
            countries={countries}
            current={s?.country ?? undefined}
          />
          {preset ? (
            <p className="text-muted mt-3 text-xs">
              {t("tax.presetSource", { source: preset.source })}
            </p>
          ) : null}
        </Card>
        <Card title={t("tax.settingsTitle")}>
          <TaxSettingsForm
            action={updateTaxSettingsAction.bind(null, orgSlug)}
            countries={countries}
            codes={setup.codes
              .filter((c) => !c.archivedAt)
              .map((c) => ({ value: c.id, label: codeLabel(c) }))}
            defaults={{
              country: s?.country ?? undefined,
              vatRegistered: s?.vatRegistered ?? false,
              vatNumber: s?.vatNumber ?? undefined,
              pricesIncludeTax: s?.pricesIncludeTax ?? false,
              defaultSalesTaxCodeId: s?.defaultSalesTaxCodeId ?? undefined,
              defaultPurchaseTaxCodeId: s?.defaultPurchaseTaxCodeId ?? undefined,
            }}
          />
        </Card>
        <Card title={t("tax.codesTitle")}>
          {setup.codes.length === 0 ? (
            <p className="text-muted text-sm">{t("tax.noCodes")}</p>
          ) : (
            <div className="space-y-4">
              {setup.codes.map((c) => (
                <div
                  key={c.id}
                  className="border-border rounded-lg border p-4"
                  data-testid={`tax-code-${c.code}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      <span className="ltr-value font-mono">{c.code}</span> —{" "}
                      {(locale === "ar" && c.nameAr) || c.name}
                    </p>
                    <Badge tone="neutral">{t(`tax.categories.${c.category}`)}</Badge>
                  </div>
                  <Table label={t("tax.rates")}>
                    <thead>
                      <tr>
                        <Th>{t("tax.effectiveFrom")}</Th>
                        <Th>{t("tax.rate")}</Th>
                        <Th>{t("tax.source")}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.rates.map((r) => (
                        <tr key={r.id}>
                          <Td className="whitespace-nowrap">
                            {r.effectiveFrom.toISOString().slice(0, 10)}
                          </Td>
                          <Td className="tabular-nums">
                            <span className="ltr-value">{pct(r.rate)}</span>
                          </Td>
                          <Td>
                            <span className="text-muted text-xs">{r.source ?? "—"}</span>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <div className="mt-3">
                    <TaxRateForm action={addTaxRateAction.bind(null, orgSlug, c.id)} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-medium">{t("tax.newCode")}</h3>
            <TaxCodeForm action={createTaxCodeAction.bind(null, orgSlug)} />
          </div>
        </Card>
      </div>
    </>
  );
}
