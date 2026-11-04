import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CompanySelect } from "@/components/reports/company-select";
import { PeriodForm } from "@/components/reports/period-form";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { canSeeMenuEngineering, menuEngineering } from "@/modules/analytics/menu-engineering";
import type { MenuClass } from "@/modules/analytics/menu-rules";
import { listCompanies } from "@/modules/organizations/companies";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter, quantityFormatter } from "@/server/inventory-view";
import { reportPeriod } from "@/server/report-period";

const TONES: Record<MenuClass, "success" | "warning" | "neutral" | "danger"> = {
  STAR: "success",
  PLOWHORSE: "warning",
  PUZZLE: "neutral",
  DOG: "danger",
};
const CLASSES: MenuClass[] = ["STAR", "PLOWHORSE", "PUZZLE", "DOG"];

/** Menu engineering: popularity against contribution margin per item (ADR-107). */
export default async function MenuEngineeringPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/reports/menu-engineering">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeMenuEngineering(ctx)) notFound();
  const period = reportPeriod(sp, ctx.timeZone);
  const company = typeof sp.company === "string" && isUuid(sp.company) ? sp.company : "";
  const category = typeof sp.category === "string" && isUuid(sp.category) ? sp.category : "";
  const [t, locale, r, companies, fmt] = await Promise.all([
    getTranslations(),
    getLocale(),
    menuEngineering(ctx, period, {
      companyId: company || undefined,
      categoryId: category || undefined,
    }),
    listCompanies(ctx),
    quantityFormatter(),
  ]);
  const money = await moneyFormatter(r.currency);
  const m = (v: Decimal | null) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value whitespace-nowrap">{money.money(v)}</span>
    );
  const pct = (v: Decimal | null) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value">{v.times(100).toFixed(1)} %</span>
    );
  const name = (x: { name: string; nameAr: string | null }) =>
    (locale === "ar" && x.nameAr) || x.name;
  const query = `from=${period.from}&to=${period.to}${company ? `&company=${company}` : ""}${category ? `&category=${category}` : ""}`;
  return (
    <>
      <PageHeader
        title={t("menuEngineering.title")}
        description={t("menuEngineering.hint")}
        actions={
          <span className="flex flex-wrap gap-2">
            <a
              href={`/o/${orgSlug}/reports/menu-engineering/export?${query}`}
              className={buttonClass("secondary")}
            >
              {t("reports.downloadCsv")}
            </a>
            <a
              href={`/o/${orgSlug}/reports/menu-engineering/export?${query}&format=xlsx`}
              className={buttonClass("secondary")}
            >
              {t("common.excel")}
            </a>
          </span>
        }
      />
      <div className="space-y-6">
        <PeriodForm from={period.from} to={period.to}>
          <CompanySelect companies={companies} value={company} />
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("menuEngineering.category")}</span>
            <select name="category" defaultValue={category} className={`${inputClass} w-auto`}>
              <option value="">{t("menuEngineering.allCategories")}</option>
              {r.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {name(c)}
                </option>
              ))}
            </select>
          </label>
        </PeriodForm>
        {r.missingRates.length > 0 ? (
          <Alert tone="error">
            {t("fx.missingRates", { currencies: r.missingRates.join(", ") })}
          </Alert>
        ) : null}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="menu-classes">
          {CLASSES.map((c) => (
            <div key={c} className="border-border bg-surface rounded-xl border p-4 shadow-sm">
              <p className="text-muted text-xs font-medium">{t(`menuEngineering.classes.${c}`)}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{r.counts[c]}</p>
              <p className="text-muted text-xs">{t(`menuEngineering.advice.${c}`)}</p>
            </div>
          ))}
        </div>
        <p className="text-muted text-xs">
          {r.popularityThreshold && r.averageMargin
            ? t("menuEngineering.basis", {
                currency: r.currency,
                threshold: r.popularityThreshold.times(100).toFixed(1),
                margin: money.money(r.averageMargin),
              })
            : t("menuEngineering.noBasis")}
        </p>
        <Card title={t("menuEngineering.items")}>
          {r.items.length === 0 ? (
            <EmptyState title={t("menuEngineering.empty")} />
          ) : (
            <Table label={t("menuEngineering.items")}>
              <thead>
                <tr>
                  <Th>{t("menuEngineering.item")}</Th>
                  <Th>{t("menuEngineering.class")}</Th>
                  <Th>{t("menuEngineering.sold")}</Th>
                  <Th>{t("menuEngineering.mix")}</Th>
                  <Th>{t("menuEngineering.averagePrice")}</Th>
                  <Th>{t("menuEngineering.unitCost")}</Th>
                  <Th>{t("menuEngineering.unitMargin")}</Th>
                  <Th>{t("menuEngineering.totalMargin")}</Th>
                  <Th>{t("menuEngineering.foodCost")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.items.map((i) => (
                  <tr key={i.item.id}>
                    <Td>
                      {name(i.item)}
                      <span className="text-muted block text-xs">
                        <span className="ltr-value font-mono">{i.item.code}</span> ·{" "}
                        {name(i.category)}
                      </span>
                    </Td>
                    <Td>
                      {i.menuClass ? (
                        <Badge tone={TONES[i.menuClass]}>
                          {t(`menuEngineering.classes.${i.menuClass}`)}
                        </Badge>
                      ) : (
                        <span className="text-muted text-xs">
                          {t(`menuEngineering.gaps.${i.costGap ?? "NONE"}`)}
                        </span>
                      )}
                      {i.costIncomplete ? (
                        <span className="text-muted block text-xs">
                          {t("menuEngineering.incomplete")}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="ltr-value tabular-nums">{fmt(i.sold)}</Td>
                    <Td>{pct(i.mixShare)}</Td>
                    <Td className="tabular-nums">{m(i.averagePrice)}</Td>
                    <Td className="tabular-nums">{m(i.unitCost)}</Td>
                    <Td className="font-medium tabular-nums">{m(i.unitMargin)}</Td>
                    <Td className="tabular-nums">{m(i.totalMargin)}</Td>
                    <Td>{pct(i.foodCost)}</Td>
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
