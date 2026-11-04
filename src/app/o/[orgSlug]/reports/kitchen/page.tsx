import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PeriodForm } from "@/components/reports/period-form";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import {
  canSeeKitchenPerformance,
  kitchenPerformance,
} from "@/modules/analytics/kitchen-performance";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { reportPeriod } from "@/server/report-period";

/** Kitchen display performance: ticket times per station, hour and day (ADR-108). */
export default async function KitchenPerformancePage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/reports/kitchen">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeKitchenPerformance(ctx)) notFound();
  const period = reportPeriod(sp, ctx.timeZone);
  const branch = typeof sp.branch === "string" && isUuid(sp.branch) ? sp.branch : "";
  const [t, r] = await Promise.all([
    getTranslations(),
    kitchenPerformance(ctx, period, { branchId: branch || undefined }),
  ]);
  const min = (s: number | null) =>
    s === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value tabular-nums">
        {t("kitchenReport.minutes", { m: (s / 60).toFixed(1) })}
      </span>
    );
  const pct = (v: Decimal | null) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="ltr-value">{v.times(100).toFixed(1)} %</span>
    );
  const query = `from=${period.from}&to=${period.to}${branch ? `&branch=${branch}` : ""}`;
  const busiest = Math.max(1, ...r.hours.map((h) => h.sent));
  return (
    <>
      <PageHeader
        title={t("kitchenReport.title")}
        description={t("kitchenReport.hint")}
        actions={
          <span className="flex flex-wrap gap-2">
            <a
              href={`/o/${orgSlug}/reports/kitchen/export?${query}`}
              className={buttonClass("secondary")}
            >
              {t("reports.downloadCsv")}
            </a>
            <a
              href={`/o/${orgSlug}/reports/kitchen/export?${query}&format=xlsx`}
              className={buttonClass("secondary")}
            >
              {t("common.excel")}
            </a>
          </span>
        }
      />
      <div className="space-y-6">
        <PeriodForm from={period.from} to={period.to}>
          {r.branches.length > 1 || branch ? (
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("kitchenReport.branch")}</span>
              <select name="branch" defaultValue={branch} className={`${inputClass} w-auto`}>
                <option value="">{t("kitchenReport.allBranches")}</option>
                {r.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </PeriodForm>
        {r.truncated ? <Alert tone="info">{t("kitchenReport.truncated")}</Alert> : null}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="kitchen-totals">
          {[
            {
              label: t("kitchenReport.sent"),
              value: <span className="ltr-value">{r.total.sent}</span>,
            },
            { label: t("kitchenReport.median"), value: min(r.total.medianSeconds) },
            { label: t("kitchenReport.p90"), value: min(r.total.p90Seconds) },
            { label: t("kitchenReport.withinTarget"), value: pct(r.total.withinTarget) },
            { label: t("kitchenReport.average"), value: min(r.total.meanSeconds) },
            {
              label: t("kitchenReport.openNow"),
              value: <span className="ltr-value">{r.total.openNow}</span>,
            },
            {
              label: t("kitchenReport.lateNow"),
              value: <span className="ltr-value">{r.total.lateNow}</span>,
            },
            {
              label: t("kitchenReport.voided"),
              value: <span className="ltr-value">{r.total.voidedItems}</span>,
            },
          ].map((k) => (
            <div key={k.label} className="border-border bg-surface rounded-xl border p-4 shadow-sm">
              <p className="text-muted text-xs font-medium">{k.label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{k.value}</p>
            </div>
          ))}
        </div>
        <p className="text-muted text-xs">{t("kitchenReport.basis")}</p>

        <Card title={t("kitchenReport.byStation")}>
          {r.stations.length === 0 ? (
            <EmptyState title={t("kitchenReport.noStations")} />
          ) : (
            <Table label={t("kitchenReport.byStation")}>
              <thead>
                <tr>
                  <Th>{t("kitchenReport.station")}</Th>
                  <Th>{t("kitchenReport.target")}</Th>
                  <Th>{t("kitchenReport.sent")}</Th>
                  <Th>{t("kitchenReport.median")}</Th>
                  <Th>{t("kitchenReport.p90")}</Th>
                  <Th>{t("kitchenReport.withinTarget")}</Th>
                  <Th>{t("kitchenReport.notBumped")}</Th>
                  <Th>{t("kitchenReport.lateNow")}</Th>
                  <Th>{t("kitchenReport.items")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.stations.map((s) => (
                  <tr key={s.station.id}>
                    <Td>
                      {s.station.name}
                      <span className="ltr-value text-muted block font-mono text-xs">
                        {s.branch.code} · {s.station.code}
                      </span>
                    </Td>
                    <Td className="ltr-value tabular-nums">
                      {t("kitchenReport.minutes", { m: s.station.targetMinutes })}
                    </Td>
                    <Td className="ltr-value tabular-nums">{s.sent}</Td>
                    <Td>{min(s.medianSeconds)}</Td>
                    <Td>{min(s.p90Seconds)}</Td>
                    <Td>{pct(s.withinTarget)}</Td>
                    <Td className="ltr-value tabular-nums">{s.stillOpen}</Td>
                    <Td className="ltr-value tabular-nums">{s.lateNow}</Td>
                    <Td className="ltr-value tabular-nums">
                      {s.items}
                      {s.voidedItems > 0 ? (
                        <span className="text-muted block text-xs">
                          {t("kitchenReport.voidedCount", { n: s.voidedItems })}
                        </span>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title={t("kitchenReport.byHour")}>
          {r.total.sent === 0 ? (
            <EmptyState title={t("kitchenReport.empty")} />
          ) : (
            <ul className="space-y-1" data-testid="kitchen-hours">
              {r.hours
                .filter((h) => h.sent > 0)
                .map((h) => (
                  <li key={h.hour} className="flex items-center gap-3 text-sm">
                    <span className="ltr-value w-14 font-mono tabular-nums">
                      {String(h.hour).padStart(2, "0")}:00
                    </span>
                    <span className="bg-surface-muted relative h-4 flex-1 overflow-hidden rounded">
                      <span
                        className="bg-primary absolute inset-y-0 start-0 rounded"
                        style={{ width: `${((h.sent / busiest) * 100).toFixed(1)}%` }}
                      />
                    </span>
                    <span className="ltr-value w-10 text-end tabular-nums">{h.sent}</span>
                    <span className="w-24 text-end">{min(h.medianSeconds)}</span>
                    <span className="w-16 text-end">{pct(h.withinTarget)}</span>
                  </li>
                ))}
            </ul>
          )}
        </Card>

        <Card title={t("kitchenReport.byDay")}>
          {r.days.length === 0 ? (
            <EmptyState title={t("kitchenReport.empty")} />
          ) : (
            <Table label={t("kitchenReport.byDay")}>
              <thead>
                <tr>
                  <Th>{t("kitchenReport.day")}</Th>
                  <Th>{t("kitchenReport.sent")}</Th>
                  <Th>{t("kitchenReport.median")}</Th>
                  <Th>{t("kitchenReport.p90")}</Th>
                  <Th>{t("kitchenReport.withinTarget")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.days.map((d) => (
                  <tr key={d.day}>
                    <Td className="ltr-value tabular-nums">{d.day}</Td>
                    <Td className="ltr-value tabular-nums">{d.sent}</Td>
                    <Td>{min(d.medianSeconds)}</Td>
                    <Td>{min(d.p90Seconds)}</Td>
                    <Td>{pct(d.withinTarget)}</Td>
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
