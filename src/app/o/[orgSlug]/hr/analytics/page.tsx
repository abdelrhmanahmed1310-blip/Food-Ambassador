import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Card, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hrAnalytics } from "@/modules/hr-analytics/service";
import { TENURE_BANDS } from "@/modules/hr-analytics/rules";
import { canViewHr } from "@/modules/hr/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div data-testid={testId}>
      <dt className="text-muted text-sm">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** HR analytics across the HR modules (ADR-130). */
export default async function HrAnalyticsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/hr/analytics">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canViewHr(ctx)) notFound();
  const [t, r] = await Promise.all([
    getTranslations("hrAnalytics"),
    hrAnalytics(ctx, { from: sp.from, to: sp.to, branchId: sp.branch }),
  ]);
  const p = (v: number | null) => (v === null ? "—" : `${v}%`);
  const n = (v: number | null) => (v === null ? "—" : String(v));
  const from = r.range.months[0];
  const to = r.range.months.at(-1)!;
  const query = new URLSearchParams({ from, to, ...(r.branch ? { branch: r.branch.id } : {}) });
  const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("hint")}
        actions={
          <LinkButton href={`/o/${orgSlug}/hr/analytics/export?${query}`} variant="secondary">
            {t("exportCsv")}
          </LinkButton>
        }
      />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block font-medium">{t("from")}</span>
            <input
              type="month"
              name="from"
              defaultValue={from}
              className="border-border bg-surface rounded-lg border px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="block font-medium">{t("to")}</span>
            <input
              type="month"
              name="to"
              defaultValue={to}
              className="border-border bg-surface rounded-lg border px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="block font-medium">{t("branch")}</span>
            <select
              name="branch"
              defaultValue={r.branch?.id ?? ""}
              className="border-border bg-surface rounded-lg border px-3 py-2"
            >
              <option value="">{t("allBranches")}</option>
              {r.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="border-border rounded-lg border px-3 py-2 text-sm">
            {t("show")}
          </button>
        </form>

        <Card title={t("headcount")}>
          <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label={t("start")} value={String(r.summary.start)} />
            <Stat label={t("end")} value={String(r.summary.end)} testId="stat-end" />
            <Stat label={t("average")} value={String(r.summary.averageHeadcount)} />
            <Stat label={t("hires")} value={String(r.summary.hires)} testId="stat-hires" />
            <Stat label={t("leavers")} value={String(r.summary.leavers)} testId="stat-leavers" />
            <Stat label={t("turnover")} value={p(r.summary.turnover)} testId="stat-turnover" />
          </dl>
          <div className="mt-4">
            <Table label={t("byMonth")}>
              <thead>
                <tr>
                  <Th>{t("month")}</Th>
                  <Th>{t("start")}</Th>
                  <Th>{t("end")}</Th>
                  <Th>{t("hires")}</Th>
                  <Th>{t("leavers")}</Th>
                  <Th>{t("turnover")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.series.map((m) => (
                  <tr key={m.month}>
                    <Td className="tabular-nums">{m.month}</Td>
                    <Td className="tabular-nums">{m.start}</Td>
                    <Td className="tabular-nums">{m.end}</Td>
                    <Td className="tabular-nums">{m.hires}</Td>
                    <Td className="tabular-nums">{m.leavers}</Td>
                    <Td className="tabular-nums">{p(m.turnover)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <p className="text-muted mt-2 text-xs">{t("headcountNote")}</p>
        </Card>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card title={t("byBranch", { date: r.people.at })}>
            <ul className="space-y-1 text-sm">
              {r.people.byBranch.map((b) => (
                <li key={b.key} className="flex justify-between">
                  <span>{b.key}</span>
                  <span className="tabular-nums">{b.count}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title={t("byDepartment")}>
            <ul className="space-y-1 text-sm">
              {r.people.byDepartment.map((d) => (
                <li key={d.key} className="flex justify-between">
                  <span>{d.key || t("noDepartment")}</span>
                  <span className="tabular-nums">{d.count}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title={t("tenure")}>
            <ul className="space-y-1 text-sm">
              {TENURE_BANDS.map((b) => (
                <li key={b} className="flex justify-between">
                  <span>{t(`tenureBands.${b}`)}</span>
                  <span className="tabular-nums">{r.people.tenure[b]}</span>
                </li>
              ))}
            </ul>
            <p className="text-muted mt-3 text-sm">
              {t("retention", {
                rate: p(r.people.newHireRetention.rate),
                kept: r.people.newHireRetention.kept,
                cohort: r.people.newHireRetention.cohort,
              })}
            </p>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title={t("absence")}>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Stat label={t("leaveDays")} value={String(r.absence.days)} testId="stat-leave" />
              <Stat label={t("absenceRate")} value={p(r.absence.rate)} />
            </dl>
            <ul className="mt-3 space-y-1 text-sm">
              {r.absence.byType.map((x) => (
                <li key={x.type} className="flex justify-between">
                  <span>
                    {x.type} {x.paid ? "" : `(${t("unpaid")})`}
                  </span>
                  <span className="tabular-nums">{x.days}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title={t("rosters")}>
            {r.rosters.shifts === 0 ? (
              <p className="text-muted text-sm">{t("noShifts")}</p>
            ) : (
              <dl className="grid gap-4 sm:grid-cols-3">
                <Stat label={t("shifts")} value={String(r.rosters.shifts)} />
                <Stat label={t("noShowRate")} value={p(r.rosters.noShowRate)} />
                <Stat label={t("lateRate")} value={p(r.rosters.lateRate)} />
                <Stat label={t("plannedHours")} value={hm(r.rosters.plannedMinutes)} />
                <Stat label={t("workedHours")} value={hm(r.rosters.workedMinutes)} />
                <Stat label={t("overtimeApproved")} value={hm(r.rosters.overtimeApprovedMinutes)} />
              </dl>
            )}
          </Card>
        </div>

        {r.recruitment ? (
          <Card title={t("recruitment")}>
            <dl
              className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6"
              data-testid="recruitment-stats"
            >
              <Stat label={t("openings")} value={String(r.recruitment.openings)} />
              <Stat label={t("places")} value={String(r.recruitment.places)} />
              <Stat
                label={t("applicationsPerOpening")}
                value={n(r.recruitment.applicationsPerOpening)}
              />
              <Stat label={t("hiresFromRecruitment")} value={String(r.recruitment.hires)} />
              <Stat
                label={t("timeToHire")}
                value={
                  r.recruitment.timeToHire.average === null
                    ? "—"
                    : t("days", { days: r.recruitment.timeToHire.average })
                }
              />
              <Stat label={t("offerAcceptance")} value={p(r.recruitment.offerAcceptance)} />
            </dl>
            {r.recruitment.sources.length ? (
              <p className="text-muted mt-3 text-sm">
                {t("sourcesOfHire")}:{" "}
                {r.recruitment.sources
                  .map((s) => `${t(`sources.${s.source}`)} ${s.count}`)
                  .join(" · ")}
              </p>
            ) : null}
          </Card>
        ) : null}

        {r.pay ? (
          <Card title={t("pay")}>
            {r.pay.length === 0 ? (
              <p className="text-muted text-sm">{t("noPay")}</p>
            ) : (
              <Table label={t("pay")}>
                <thead>
                  <tr>
                    <Th>{t("month")}</Th>
                    <Th>{t("currency")}</Th>
                    <Th>{t("paidPeople")}</Th>
                    <Th>{t("gross")}</Th>
                    <Th>{t("employerCost")}</Th>
                    <Th>{t("perHead")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.pay.map((x) => (
                    <tr key={`${x.month}-${x.currency}`}>
                      <Td className="tabular-nums">{x.month}</Td>
                      <Td>{x.currency}</Td>
                      <Td className="tabular-nums">{x.people}</Td>
                      <Td className="tabular-nums">{x.gross}</Td>
                      <Td className="tabular-nums">{x.employerCost}</Td>
                      <Td className="tabular-nums">{x.perHead}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <p className="text-muted mt-2 text-xs">{t("payNote")}</p>
          </Card>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-2">
          {r.training ? (
            <Card title={t("training")}>
              {r.training.required === 0 ? (
                <p className="text-muted text-sm">{t("noRequirements")}</p>
              ) : (
                <dl className="grid gap-4 sm:grid-cols-2">
                  <Stat label={t("compliance")} value={p(r.training.rate)} />
                  <Stat label={t("lapsed")} value={String(r.training.lapsed)} />
                  <Stat label={t("expiring")} value={String(r.training.expiring)} />
                  <Stat label={t("due")} value={String(r.training.due)} />
                </dl>
              )}
            </Card>
          ) : null}
          {r.performance ? (
            <Card title={t("performance")}>
              {r.performance.rated === 0 ? (
                <p className="text-muted text-sm">{t("noRatings")}</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {([5, 4, 3, 2, 1] as const).map((k) => (
                    <li key={k} className="flex justify-between">
                      <span>{t("ratingN", { rating: k })}</span>
                      <span className="tabular-nums">{r.performance!.distribution[k]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
