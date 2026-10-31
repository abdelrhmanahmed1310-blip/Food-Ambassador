import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ExchangeRateForm, ExchangeRateImportForm } from "@/components/fx/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { DOCUMENT_CURRENCIES, MAX_RATE_AGE_DAYS } from "@/modules/fx/rules";
import { listExchangeRates } from "@/modules/fx/service";
import { businessDate } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { importExchangeRatesAction, setExchangeRateAction } from "./actions";

const day = (d: Date) => d.toISOString().slice(0, 10);

export default async function ExchangeRatesPage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/exchange-rates">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "fx.manage")) notFound();
  const [t, rates] = await Promise.all([getTranslations("fx"), listExchangeRates(ctx)]);
  const today = businessDate(ctx.timeZone);
  const rate = (v: { toString(): string }) => v.toString().replace(/\.?0+$/, "");
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("intro", { base: ctx.baseCurrency, days: MAX_RATE_AGE_DAYS })}
      />
      <div className="space-y-6">
        <Table label={t("latest")}>
          <thead>
            <tr>
              <Th>{t("currency")}</Th>
              <Th>{t("rateLabel", { base: ctx.baseCurrency })}</Th>
              <Th>{t("rateDate")}</Th>
            </tr>
          </thead>
          <tbody>
            {rates.latest.map((l) => (
              <tr key={l.currency} data-testid={`fx-latest-${l.currency}`}>
                <Td>
                  <span className="ltr-value font-mono">{l.currency}</span>
                </Td>
                <Td className="tabular-nums">
                  {l.rate ? <span className="ltr-value">{rate(l.rate.rate)}</span> : "—"}
                </Td>
                <Td>
                  {l.rate ? (
                    <span className="ltr-value">{day(l.rate.rateDate)}</span>
                  ) : (
                    <Badge tone="warning">{t("noRate")}</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Card title={t("addRate")}>
          <ExchangeRateForm
            action={setExchangeRateAction.bind(null, orgSlug)}
            currencies={DOCUMENT_CURRENCIES.filter((c) => c !== ctx.baseCurrency)}
            base={ctx.baseCurrency}
            today={today}
          />
        </Card>
        <Card title={t("importTitle")}>
          <ExchangeRateImportForm action={importExchangeRatesAction.bind(null, orgSlug)} />
        </Card>
        <Card title={t("history")}>
          {rates.history.length === 0 ? (
            <EmptyState title={t("noRates")} />
          ) : (
            <Table label={t("history")}>
              <thead>
                <tr>
                  <Th>{t("rateDate")}</Th>
                  <Th>{t("currency")}</Th>
                  <Th>{t("rateLabel", { base: ctx.baseCurrency })}</Th>
                  <Th>{t("source")}</Th>
                </tr>
              </thead>
              <tbody>
                {rates.history.map((h) => (
                  <tr key={h.id}>
                    <Td>
                      <span className="ltr-value">{day(h.rateDate)}</span>
                    </Td>
                    <Td>
                      <span className="ltr-value font-mono">{h.currency}</span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value">{rate(h.rate)}</span>
                    </Td>
                    <Td>{t(`sources.${h.source}`)}</Td>
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
