import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { CopyWeekForm, ShiftForm } from "@/components/rosters/forms";
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { canViewHr } from "@/modules/hr/service";
import { addDays } from "@/modules/inventory/rules";
import { rosterWeek } from "@/modules/rosters/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { addShiftAction, copyWeekAction, publishWeekAction } from "./actions";
import { hm, OUTCOME_TONE, outcomeOf } from "./status";

/** A branch's roster for a week, compared with clock-ins (ADR-128). */
export default async function RostersPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/hr/rosters">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canViewHr(ctx)) notFound();
  const [t, format, w] = await Promise.all([
    getTranslations("rosters"),
    getFormatter(),
    rosterWeek(ctx, { branchId: sp.branch, week: sp.week }),
  ]);
  const base = `/o/${orgSlug}/hr/rosters`;
  if (!w)
    return (
      <>
        <PageHeader title={t("title")} description={t("hint")} />
        <EmptyState title={t("noBranches")} />
      </>
    );
  const href = (week: string) => `${base}?branch=${w.branch.id}&week=${week}`;
  const dayLabel = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  const people = w.employees.filter(
    (e) => e.branchId === w.branch.id || w.shifts.some((s) => s.employeeId === e.id),
  );
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("hint")}
        actions={
          holdsAnyGrant(ctx.grants, "hr.manage") ? (
            <LinkButton href={`${base}/settings`} variant="secondary">
              {t("settings")}
            </LinkButton>
          ) : null
        }
      />
      <div className="space-y-6">
        <form className="flex flex-wrap items-end gap-3" method="get">
          <label className="text-sm">
            <span className="block font-medium">{t("branch")}</span>
            <select
              name="branch"
              defaultValue={w.branch.id}
              className="border-border bg-surface rounded-lg border px-3 py-2"
            >
              {w.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block font-medium">{t("week")}</span>
            <input
              type="date"
              name="week"
              defaultValue={w.week}
              className="border-border bg-surface rounded-lg border px-3 py-2"
            />
          </label>
          <button type="submit" className="border-border rounded-lg border px-3 py-2 text-sm">
            {t("show")}
          </button>
          <Link className="text-sm underline" href={href(addDays(w.week, -7))}>
            {t("previousWeek")}
          </Link>
          <Link className="text-sm underline" href={href(addDays(w.week, 7))}>
            {t("nextWeek")}
          </Link>
        </form>

        <Table label={t("title")}>
          <thead>
            <tr>
              <Th>{t("employee")}</Th>
              {w.days.map((d) => (
                <Th key={d}>{dayLabel(d)}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.length === 0 ? (
              <tr>
                <td colSpan={8} className="border-border text-muted border-t px-4 py-3">
                  {t("noStaff")}
                </td>
              </tr>
            ) : (
              people.map((e) => (
                <tr key={e.id}>
                  <Td>
                    <span className="font-medium">
                      {e.firstName} {e.lastName}
                    </span>
                    <span className="text-muted block text-xs">{e.jobTitle}</span>
                  </Td>
                  {w.days.map((d) => (
                    <Td key={d}>
                      <ul className="space-y-1">
                        {w.shifts
                          .filter((s) => s.employeeId === e.id && iso(s.day) === d)
                          .map((s) => {
                            const o = outcomeOf(s.comparison);
                            return (
                              <li key={s.id} data-testid="roster-shift">
                                <Link
                                  href={`${base}/shifts/${s.id}`}
                                  className={`tabular-nums underline ${s.cancelledAt ? "line-through" : ""}`}
                                >
                                  {s.startTime}–{s.endTime}
                                </Link>{" "}
                                {s.cancelledAt ? (
                                  <Badge tone="muted">{t("cancelled")}</Badge>
                                ) : !s.publishedAt ? (
                                  <Badge tone="muted">{t("draft")}</Badge>
                                ) : o ? (
                                  <Badge tone={OUTCOME_TONE[o]}>{t(`outcomes.${o}`)}</Badge>
                                ) : null}
                                {s.comparison?.lateMinutes ? (
                                  <span className="text-muted block text-xs">
                                    {t("lateBy", { minutes: s.comparison.lateMinutes })}
                                  </span>
                                ) : null}
                                {s.comparison?.overtimeMinutes ? (
                                  <span className="text-muted block text-xs">
                                    {t("overtimeOf", { time: hm(s.comparison.overtimeMinutes) })}
                                    {s.overtime
                                      ? ` · ${t(`overtimeStatus.${s.overtime.status}`)}`
                                      : ""}
                                  </span>
                                ) : null}
                              </li>
                            );
                          })}
                      </ul>
                    </Td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </Table>

        <Card title={t("totals")}>
          <dl className="grid gap-3 text-sm sm:grid-cols-3" data-testid="roster-totals">
            <div>
              <dt className="text-muted">{t("plannedHours")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{hm(w.totals.plannedMinutes)}</dd>
            </div>
            <div>
              <dt className="text-muted">{t("workedHours")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{hm(w.totals.workedMinutes)}</dd>
            </div>
            <div>
              <dt className="text-muted">{t("overtimeHours")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{hm(w.totals.overtimeMinutes)}</dd>
            </div>
            {w.totals.cost ? (
              <>
                <div>
                  <dt className="text-muted">{t("plannedCost")}</dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {w.totals.cost.planned} {w.totals.cost.currency}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">{t("workedCost")}</dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {w.totals.cost.worked} {w.totals.cost.currency}
                  </dd>
                </div>
              </>
            ) : null}
          </dl>
          {w.totals.cost ? (
            <p className="text-muted mt-3 text-xs">
              {t("costNote")}
              {w.totals.cost.uncosted ? ` ${t("uncosted", { count: w.totals.cost.uncosted })}` : ""}
            </p>
          ) : null}
        </Card>

        {w.can.manage ? (
          <>
            <Card title={t("addShift")}>
              <ShiftForm
                action={addShiftAction.bind(null, orgSlug)}
                branchId={w.branch.id}
                employees={people.map((e) => ({
                  value: e.id,
                  label: `${e.firstName} ${e.lastName}`,
                }))}
                days={w.days.map((d) => ({ value: d, label: dayLabel(d) }))}
                templates={w.templates.map((x) => ({
                  value: x.id,
                  label: `${x.name} (${x.startTime}–${x.endTime})`,
                }))}
              />
            </Card>
            <div className="flex flex-wrap items-end gap-4">
              {w.drafts ? (
                <ConfirmActionButton
                  action={publishWeekAction.bind(null, orgSlug, w.branch.id, w.week)}
                  label={t("publish", { count: w.drafts })}
                  confirmMessage={t("publishConfirm")}
                  variant="primary"
                />
              ) : null}
              <CopyWeekForm
                action={copyWeekAction.bind(null, orgSlug, w.branch.id, w.week)}
                weeks={[1, 2, 3, 4].map((n) => {
                  const wk = addDays(w.week, -7 * n);
                  return { value: wk, label: t("weekOf", { date: dayLabel(wk) }) };
                })}
              />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
