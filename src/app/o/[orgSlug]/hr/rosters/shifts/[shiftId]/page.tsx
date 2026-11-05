import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { OvertimeForm, ReasonForm } from "@/components/rosters/forms";
import { Alert, Badge, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getShift } from "@/modules/rosters/service";
import { paidMinutes } from "@/modules/rosters/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { cancelShiftAction, decideOvertimeAction, removeShiftAction } from "../../actions";
import { hm, OUTCOME_TONE, outcomeOf } from "../../status";

/** A rostered shift against the clock-ins, with its overtime decision (ADR-128). */
export default async function ShiftPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/rosters/shifts/[shiftId]">) {
  const { orgSlug, shiftId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!isUuid(shiftId)) notFound();
  const [t, format, r] = await Promise.all([
    getTranslations("rosters"),
    getFormatter(),
    getShift(ctx, shiftId),
  ]);
  const s = r.shift;
  const c = r.comparison;
  const o = outcomeOf(c);
  const day = s.day.toISOString().slice(0, 10);
  const back = `/o/${orgSlug}/hr/rosters?branch=${s.branchId}&week=${day}`;
  const when = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: r.branch.tz });
  return (
    <>
      <PageHeader
        title={`${r.employee.firstName} ${r.employee.lastName} · ${s.startTime}–${s.endTime}`}
        description={`${r.branch.code} — ${r.branch.name} · ${day}`}
        actions={
          s.cancelledAt ? (
            <Badge tone="muted">{t("cancelled")}</Badge>
          ) : !s.publishedAt ? (
            <Badge tone="muted">{t("draft")}</Badge>
          ) : o ? (
            <Badge tone={OUTCOME_TONE[o]}>{t(`outcomes.${o}`)}</Badge>
          ) : null
        }
      />
      <div className="space-y-6">
        <Card title={t("plan")}>
          <DescriptionList
            items={[
              { label: t("start"), value: when(s.startsAt) },
              { label: t("end"), value: when(s.endsAt) },
              { label: t("breakMinutes"), value: s.breakMinutes },
              {
                label: t("plannedHours"),
                value: hm(paidMinutes(s.startsAt, s.endsAt, s.breakMinutes)),
              },
              ...(s.note ? [{ label: t("note"), value: s.note }] : []),
              ...(s.cancelReason ? [{ label: t("cancelReason"), value: s.cancelReason }] : []),
            ]}
          />
        </Card>
        {c ? (
          <Card title={t("actual")}>
            <div data-testid="shift-comparison">
              <DescriptionList
                items={[
                  { label: t("late"), value: t("minutesValue", { minutes: c.lateMinutes }) },
                  { label: t("leftEarly"), value: t("minutesValue", { minutes: c.earlyMinutes }) },
                  { label: t("workedHours"), value: hm(c.workedMinutes) },
                  { label: t("overtimeHours"), value: hm(c.overtimeMinutes) },
                ]}
              />
            </div>
            {c.outcome === "INCOMPLETE" ? (
              <div className="mt-3">
                <Alert tone="info">{t("incompleteHint")}</Alert>
              </div>
            ) : null}
          </Card>
        ) : null}
        {r.overtime ? (
          <Card title={t("overtimeDecision")}>
            <p className="text-sm" data-testid="overtime-decision">
              {t(`overtimeStatus.${r.overtime.status}`)} ·{" "}
              {t("approvedOf", {
                approved: hm(r.overtime.minutes),
                measured: hm(r.overtime.measuredMinutes),
              })}
              {r.overtime.note ? ` · ${r.overtime.note}` : ""}
            </p>
            {r.overtime.adjustment && r.overtime.adjustment.run.status !== "CANCELLED" ? (
              <p className="text-muted mt-1 text-sm">
                {t("inPayroll", { number: r.overtime.adjustment.run.number })}
              </p>
            ) : null}
          </Card>
        ) : r.can.decideOvertime && c ? (
          <Card title={t("overtimeDecision")}>
            <OvertimeForm
              action={decideOvertimeAction.bind(null, orgSlug, s.id)}
              measured={c.overtimeMinutes}
            />
          </Card>
        ) : null}
        {r.can.manage && !s.cancelledAt ? (
          s.publishedAt ? (
            !r.overtime ? (
              <ReasonForm
                action={cancelShiftAction.bind(null, orgSlug, s.id)}
                label={t("cancelShift")}
              />
            ) : null
          ) : (
            <ConfirmActionButton
              action={removeShiftAction.bind(null, orgSlug, s.id, back)}
              label={t("removeShift")}
            />
          )
        ) : null}
        {r.can.manage ? (
          <Link href={back} className="text-sm underline">
            {t("backToWeek")}
          </Link>
        ) : null}
      </div>
    </>
  );
}
