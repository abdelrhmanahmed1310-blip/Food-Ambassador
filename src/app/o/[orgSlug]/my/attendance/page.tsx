import { getTranslations } from "next-intl/server";
import { PhoneClock } from "@/components/hr/attendance-forms";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { myAttendance } from "@/modules/hr/attendance";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { phoneClockAction } from "./actions";

const hours = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

/** The signed-in employee clocks in and out and sees their week (ADR-080). */
export default async function MyAttendancePage({
  params,
}: PageProps<"/o/[orgSlug]/my/attendance">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, mine] = await Promise.all([getTranslations("attendance"), myAttendance(ctx)]);
  if (!mine)
    return (
      <>
        <PageHeader title={t("myTitle")} />
        <EmptyState title={t("notLinked")} hint={t("notLinkedHint")} />
      </>
    );
  const time = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: mine.timeZone,
        }).format(d)
      : "?";
  return (
    <>
      <PageHeader
        title={t("myTitle")}
        description={`${mine.employee.firstName} ${mine.employee.lastName} · ${mine.employee.branch}`}
      />
      <div className="mx-auto max-w-xl space-y-6">
        <Card>
          <p className="mb-3 text-sm" data-testid="my-state">
            {mine.clockedIn ? t("youAreIn") : t("youAreOut")}
          </p>
          {mine.employee.status === "ACTIVE" ? (
            <PhoneClock
              action={phoneClockAction.bind(null, orgSlug)}
              clockedIn={mine.clockedIn}
              needsLocation={mine.needsLocation}
            />
          ) : (
            <Badge tone="warning">{t("onLeave")}</Badge>
          )}
        </Card>
        <Card title={t("myWeek")}>
          {mine.days.length === 0 ? (
            <p className="text-muted text-sm">{t("noPunches")}</p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {mine.days.map((d) => (
                <li key={d.day} className="flex items-center justify-between gap-2 py-2">
                  <span className="ltr-value">{d.day}</span>
                  <span className="ltr-value text-muted">
                    {d.sessions.map((s) => `${time(s.in)}–${s.out ? time(s.out) : "…"}`).join(", ")}
                  </span>
                  <span className="font-semibold tabular-nums">{hours(d.minutes)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
