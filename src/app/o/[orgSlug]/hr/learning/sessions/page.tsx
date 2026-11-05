import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { SessionForm } from "@/components/learning/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { businessDate } from "@/modules/inventory/rules";
import { canViewTraining, listCourses, listSessions } from "@/modules/learning/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { scheduleSessionAction } from "../actions";

const TONE = { SCHEDULED: "warning", COMPLETED: "success", CANCELLED: "muted" } as const;

export default async function SessionsPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/learning/sessions">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewTraining(ctx)) notFound();
  const [t, locale, data, catalogue] = await Promise.all([
    getTranslations("learning"),
    getLocale(),
    listSessions(ctx),
    listCourses(ctx),
  ]);
  const when = (d: Date, tz: string | null) =>
    new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-nu-latn" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: tz ?? ctx.timeZone,
    }).format(d);
  const manage = holdsAnyGrant(ctx.grants, "training.manage");
  return (
    <>
      <PageHeader title={t("sessionsTitle")} />
      <div className="space-y-6">
        {data.sessions.length === 0 ? (
          <EmptyState title={t("noSessions")} />
        ) : (
          <Table label={t("sessionsTitle")}>
            <thead>
              <tr>
                <Th>{t("number")}</Th>
                <Th>{t("course")}</Th>
                <Th>{t("branch")}</Th>
                <Th>{t("date")}</Th>
                <Th>{t("participants")}</Th>
                <Th>{t("status")}</Th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.id}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/hr/learning/sessions/${s.id}`}
                      className="text-primary ltr-value font-mono hover:underline"
                    >
                      {s.number}
                    </Link>
                  </Td>
                  <Td>
                    {s.course.code} — {(locale === "ar" && s.course.nameAr) || s.course.name}
                  </Td>
                  <Td>{s.branch.code}</Td>
                  <Td className="whitespace-nowrap">{when(s.startsAt, s.branch.timeZone)}</Td>
                  <Td className="tabular-nums">
                    {s._count.participants}
                    {s.capacity ? ` / ${s.capacity}` : ""}
                  </Td>
                  <Td>
                    <Badge tone={TONE[s.status]}>{t(`sessionStatuses.${s.status}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {manage && catalogue.courses.length > 0 ? (
          <Card title={t("schedule")}>
            <SessionForm
              action={scheduleSessionAction.bind(null, orgSlug)}
              courses={catalogue.courses.map((c) => ({
                value: c.id,
                label: `${c.code} — ${c.name}`,
              }))}
              branches={catalogue.branches.map((b) => ({
                value: b.id,
                label: `${b.code} — ${b.name}`,
              }))}
              today={businessDate(ctx.timeZone)}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
