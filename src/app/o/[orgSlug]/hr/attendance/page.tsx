import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
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
import { buttonClass, inputClass } from "@/components/ui/styles";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { attendanceBoard } from "@/modules/hr/attendance";
import { canViewHr } from "@/modules/hr/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const hours = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

/** Who is in now and the hours of a day (ADR-080). */
export default async function AttendancePage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/hr/attendance">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewHr(ctx)) notFound();
  const sp = await searchParams;
  const [t, board] = await Promise.all([
    getTranslations("attendance"),
    attendanceBoard(ctx, Array.isArray(sp.day) ? sp.day[0] : sp.day),
  ]);
  const base = `/o/${orgSlug}/hr`;
  const time = (d: Date, tz: string) =>
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(
      d,
    );
  const inNow = board.rows.filter((r) => r.inNow).length;
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("intro")}
        actions={
          holdsAnyGrant(ctx.grants, "hr.manage") ? (
            <LinkButton href={`${base}/attendance/setup`} variant="secondary">
              {t("setup")}
            </LinkButton>
          ) : null
        }
      />
      <form method="get" className="mb-4 flex items-end gap-2">
        <div>
          <label htmlFor="day" className="mb-1 block text-sm font-medium">
            {t("day")}
          </label>
          <input id="day" name="day" type="date" defaultValue={board.day} className={inputClass} />
        </div>
        <button type="submit" className={buttonClass("secondary")}>
          {t("show")}
        </button>
      </form>
      {board.day === board.today ? (
        <p className="mb-4 text-sm" data-testid="in-now">
          {t("inNow", { count: inNow })}
        </p>
      ) : null}
      {board.rows.length === 0 ? (
        <EmptyState title={t("noEmployees")} />
      ) : (
        <Card>
          <Table label={t("title")}>
            <thead>
              <tr>
                <Th>{t("employee")}</Th>
                <Th>{t("branch")}</Th>
                <Th>{t("sessions")}</Th>
                <Th>{t("hours")}</Th>
                <Th>{t("check")}</Th>
              </tr>
            </thead>
            <tbody>
              {board.rows.map((r) => (
                <tr key={r.employee.id} data-testid="attendance-row">
                  <Td>
                    <Link
                      href={`${base}/employees/${r.employee.id}`}
                      className="text-primary hover:underline"
                    >
                      {r.employee.firstName} {r.employee.lastName}
                    </Link>
                    {r.inNow ? (
                      <span className="ms-2">
                        <Badge tone="success">{t("inBadge")}</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td className="ltr-value font-mono text-xs">{r.employee.branch.code}</Td>
                  <Td className="ltr-value text-sm">
                    {r.sheet
                      ? r.sheet.sessions
                          .map(
                            (s) =>
                              `${s.in ? time(s.in, r.timeZone) : "?"}–${s.out ? time(s.out, r.timeZone) : "…"}`,
                          )
                          .join(", ")
                      : "—"}
                  </Td>
                  <Td className="tabular-nums">{r.sheet ? hours(r.sheet.minutes) : "—"}</Td>
                  <Td>
                    {r.sheet && r.sheet.issues > 0 ? (
                      <Badge tone="danger">{t("issues", { count: r.sheet.issues })}</Badge>
                    ) : r.employee.status === "ON_LEAVE" ? (
                      <Badge tone="warning">{t("onLeave")}</Badge>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
