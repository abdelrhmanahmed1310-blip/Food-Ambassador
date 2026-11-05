import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { AttendanceForm, ParticipantsForm, ReasonForm } from "@/components/learning/forms";
import {
  Badge,
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { canViewTraining, getSession } from "@/modules/learning/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  addParticipantsAction,
  attendanceAction,
  cancelSessionAction,
  completeSessionAction,
} from "../../actions";

export default async function SessionPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/learning/sessions/[sessionId]">) {
  const { orgSlug, sessionId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewTraining(ctx) || !isUuid(sessionId)) notFound();
  const [t, locale, data] = await Promise.all([
    getTranslations("learning"),
    getLocale(),
    getSession(ctx, sessionId),
  ]);
  const s = data.session;
  const when = new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-nu-latn" : "en-GB", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: s.branch.timeZone ?? ctx.timeZone,
  }).format(s.startsAt);
  return (
    <>
      <PageHeader
        title={`${s.number} · ${(locale === "ar" && s.course.nameAr) || s.course.name}`}
        description={`${s.branch.code} — ${s.branch.name}`}
        actions={<Badge tone="neutral">{t(`sessionStatuses.${s.status}`)}</Badge>}
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("date"), value: when },
              { label: t("trainer"), value: s.trainer },
              { label: t("location"), value: s.location ?? "—" },
              { label: t("capacity"), value: s.capacity ? String(s.capacity) : "—" },
              {
                label: t("validity"),
                value: s.course.validityMonths
                  ? t("validFor", { months: s.course.validityMonths })
                  : t("noExpiry"),
              },
              ...(s.cancelReason ? [{ label: t("reason"), value: s.cancelReason }] : []),
            ]}
          />
        </Card>
        {data.participants.length === 0 ? (
          <EmptyState title={t("noParticipants")} />
        ) : (
          <Table label={t("participants")}>
            <thead>
              <tr>
                <Th>{t("employee")}</Th>
                <Th>{data.canManage ? `${t("attendance")} · ${t("result")}` : t("attendance")}</Th>
                {data.canManage ? null : <Th>{t("result")}</Th>}
              </tr>
            </thead>
            <tbody>
              {data.participants.map((p) => (
                <tr key={p.id} data-testid={`participant-${p.employee.number}`}>
                  <Td>
                    {p.employee.firstName} {p.employee.lastName}
                    <span className="text-muted block text-xs">
                      {p.employee.number} · {p.employee.jobTitle}
                    </span>
                  </Td>
                  {data.canManage ? (
                    <Td>
                      <AttendanceForm
                        action={attendanceAction.bind(null, orgSlug, s.id, p.employeeId)}
                        attendance={p.attendance}
                        result={p.result}
                      />
                    </Td>
                  ) : (
                    <>
                      <Td>{t(`attendances.${p.attendance}`)}</Td>
                      <Td>{p.result ? t(`results.${p.result}`) : "—"}</Td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data.canManage ? (
          <>
            {data.candidates.length > 0 ? (
              <Card title={t("addParticipants")}>
                <ParticipantsForm
                  action={addParticipantsAction.bind(null, orgSlug, s.id)}
                  employees={data.candidates.map((c) => ({
                    value: c.id,
                    label: `${c.number} — ${c.firstName} ${c.lastName}`,
                  }))}
                />
              </Card>
            ) : null}
            <div className="flex flex-wrap items-end gap-4">
              <ConfirmActionButton
                action={completeSessionAction.bind(null, orgSlug, s.id)}
                label={t("complete")}
                confirmMessage={t("completeConfirm")}
                variant="primary"
              />
              <ReasonForm
                action={cancelSessionAction.bind(null, orgSlug, s.id)}
                label={t("cancelSession")}
              />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
